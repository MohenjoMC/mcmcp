package dev.mcmcp;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Loopback HTTP/JSON-RPC endpoint. See docs/PROTOCOL.md. */
public final class ControlServer {
    private static final int MAX_BODY = 1 << 20;
    private static final long MAX_EVENT_TIMEOUT = 30_000;

    private final Config config;
    private final Dispatcher dispatcher;
    private final Events events;
    private final String token;
    private final Logger log;
    private HttpServer server;
    private ExecutorService executor;
    private int port;
    private int startAttempts;

    public ControlServer(Config config, Dispatcher dispatcher, Events events, String token, Logger log) {
        this.config = config;
        this.dispatcher = dispatcher;
        this.events = events;
        this.token = token;
        this.log = log;
    }

    public int port() {
        return port;
    }

    /** Binds the first free port in the configured range. */
    public int start() throws IOException {
        InetAddress address = config.allowRemote ? null : InetAddress.getByName("127.0.0.1");
        IOException last = null;
        for (int candidate = config.port; candidate < config.port + 20; candidate++) {
            try {
                server = HttpServer.create(new InetSocketAddress(address, candidate), 0);
                port = candidate;
                break;
            } catch (IOException e) {
                last = e;
            }
        }
        if (server == null) {
            throw last != null ? last : new IOException("no free port");
        }
        startAttempts = port - config.port;
        executor = Executors.newCachedThreadPool(r -> {
            Thread thread = new Thread(r, "mcmcp-http");
            thread.setDaemon(true);
            return thread;
        });
        server.setExecutor(executor);
        server.createContext("/health", this::handleHealth);
        server.createContext("/rpc", this::handleRpc);
        server.createContext("/methods", this::handleMethods);
        server.createContext("/events", this::handleEvents);
        server.createContext("/shutdown", this::handleShutdown);
        server.start();
        if (startAttempts > 0) {
            log.warn("[mcmcp] port {} was busy, listening on {}", config.port, port);
        }
        log.info("[mcmcp] control server listening on 127.0.0.1:{}", port);
        return port;
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    // ---- routes -------------------------------------------------------

    private void handleHealth(HttpExchange exchange) throws IOException {
        if (requestMethod(exchange) != Method.GET) {
            respond(exchange, 405, Json.object("error", "use GET"));
            return;
        }
        JsonObject health = Json.object(
                "ok", true,
                "name", "mcmcp",
                "version", McmcpMod.VERSION,
                "mc", dev.mcmcp.compat.Compat.mcVersion(),
                "player", McmcpMod.playerName(),
                "inWorld", McmcpMod.inWorld(),
                "uptimeMs", McmcpMod.uptimeMs());
        respond(exchange, 200, health);
    }

    private void handleMethods(HttpExchange exchange) throws IOException {
        if (!authorized(exchange)) {
            unauthorized(exchange);
            return;
        }
        if (requestMethod(exchange) != Method.GET) {
            respond(exchange, 405, Json.object("error", "use GET"));
            return;
        }
        respond(exchange, 200, dispatcher.catalog());
    }

    private void handleRpc(HttpExchange exchange) throws IOException {
        if (requestMethod(exchange) != Method.POST) {
            respond(exchange, 405, Json.object("error", "use POST"));
            return;
        }
        if (!authorized(exchange)) {
            unauthorized(exchange);
            return;
        }
        String body;
        try (InputStream in = exchange.getRequestBody()) {
            byte[] bytes = in.readNBytes(MAX_BODY + 1);
            if (bytes.length > MAX_BODY) {
                respond(exchange, 413, Json.object("error", "request body too large"));
                return;
            }
            body = new String(bytes, StandardCharsets.UTF_8);
        }

        JsonObject request;
        JsonElement id = null;
        try {
            JsonElement parsed = JsonParser.parseString(body);
            if (!parsed.isJsonObject()) throw new IllegalArgumentException("not an object");
            request = parsed.getAsJsonObject();
            id = request.get("id");
            final JsonElement requestId = id;
            String method = request.has("method") ? request.get("method").getAsString() : null;
            if (method == null || method.isBlank()) {
                respondRpc(exchange, requestId, null, new McmcpException(-32600, "missing method"));
                return;
            }
            JsonObject params = request.has("params") && request.get("params").isJsonObject()
                    ? request.getAsJsonObject("params")
                    : new JsonObject();

            dispatcher.call(method, params).whenComplete((result, error) -> {
                try {
                    if (error != null) {
                        Throwable cause = unwrap(error);
                        if (cause instanceof McmcpException mc) {
                            respondRpc(exchange, requestId, null, mc);
                        } else {
                            log.warn("[mcmcp] method {} failed", method, cause);
                            JsonObject data = Json.object("method", method, "trace", trace(cause));
                            respondRpc(exchange, requestId, null, new McmcpException(-32100, String.valueOf(cause.getMessage()), data));
                        }
                        return;
                    }
                    respondRpc(exchange, requestId, result, null);
                } catch (IOException e) {
                    log.warn("[mcmcp] could not write the response for {}", method, e);
                }
            });
        } catch (Exception e) {
            respondRpc(exchange, id, null, new McmcpException(-32700, "malformed JSON: " + e.getMessage()));
        }
    }

    private void handleEvents(HttpExchange exchange) throws IOException {
        if (!authorized(exchange)) {
            unauthorized(exchange);
            return;
        }
        if (requestMethod(exchange) != Method.GET) {
            respond(exchange, 405, Json.object("error", "use GET"));
            return;
        }
        var query = parseQuery(exchange.getRequestURI().getRawQuery());
        long after = query.containsKey("after") ? Long.parseLong(query.get("after")) : -1;
        long timeout = query.containsKey("timeoutMs")
                ? Math.min(MAX_EVENT_TIMEOUT, Math.max(0, Long.parseLong(query.get("timeoutMs"))))
                : 5000;
        Set<String> types = new HashSet<>();
        if (query.containsKey("types")) {
            for (String type : query.get("types").split(",")) {
                if (!type.isBlank()) types.add(type.trim().toLowerCase(Locale.ROOT));
            }
        }
        List<Events.Event> found = events.poll(after, timeout, types);
        var array = new com.google.gson.JsonArray();
        long next = after;
        for (Events.Event event : found) {
            array.add(event.toJson());
            next = Math.max(next, event.seq());
        }
        respond(exchange, 200, Json.object("events", array, "next", Math.max(next, events.lastSeq())));
    }

    private void handleShutdown(HttpExchange exchange) throws IOException {
        if (!authorized(exchange)) {
            unauthorized(exchange);
            return;
        }
        if (requestMethod(exchange) != Method.POST) {
            respond(exchange, 405, Json.object("error", "use POST"));
            return;
        }
        respond(exchange, 200, Json.object("stopping", true));
        Thread stopper = new Thread(() -> {
            try {
                Thread.sleep(150);
            } catch (InterruptedException ignored) {
            }
            stop();
        }, "mcmcp-shutdown");
        stopper.setDaemon(true);
        stopper.start();
    }

    // ---- plumbing -----------------------------------------------------

    private boolean authorized(HttpExchange exchange) {
        if (token == null || token.isEmpty()) return false;
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header == null) header = exchange.getRequestHeaders().getFirst("X-MCMCP-Token");
        if (header == null) return false;
        String presented = header.regionMatches(true, 0, "Bearer ", 0, 7) ? header.substring(7).trim() : header.trim();
        return MessageDigest.isEqual(presented.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    private void unauthorized(HttpExchange exchange) throws IOException {
        JsonObject body = Json.object("error", "unauthorized");
        exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
        respond(exchange, 401, body);
    }

    private void respondRpc(HttpExchange exchange, JsonElement id, JsonElement result, McmcpException error) throws IOException {
        JsonObject json = new JsonObject();
        json.addProperty("jsonrpc", "2.0");
        json.add("id", id == null ? com.google.gson.JsonNull.INSTANCE : id);
        if (error != null) {
            JsonObject err = new JsonObject();
            err.addProperty("code", error.code);
            err.addProperty("message", error.getMessage());
            if (error.data != null) err.add("data", error.data);
            json.add("error", err);
        } else {
            json.add("result", result == null ? com.google.gson.JsonNull.INSTANCE : result);
        }
        respond(exchange, 200, json);
    }

    private void respond(HttpExchange exchange, int status, JsonElement body) throws IOException {
        byte[] bytes = Json.GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private enum Method {GET, POST, OTHER}

    private static Method requestMethod(HttpExchange exchange) {
        return switch (exchange.getRequestMethod().toUpperCase(Locale.ROOT)) {
            case "GET" -> Method.GET;
            case "POST" -> Method.POST;
            default -> Method.OTHER;
        };
    }

    public static java.util.Map<String, String> parseQuery(String raw) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        if (raw == null || raw.isBlank()) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            out.put(java.net.URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                    java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return out;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException) && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static String trace(Throwable t) {
        StringBuilder sb = new StringBuilder(t.toString());
        StackTraceElement[] stack = t.getStackTrace();
        for (int i = 0; i < Math.min(stack.length, 8); i++) {
            sb.append("\n  at ").append(stack[i]);
        }
        return sb.toString();
    }

    static String describePeers(HttpExchange exchange) {
        return String.valueOf(exchange.getRemoteAddress());
    }

    static boolean isLoopback(InetSocketAddress address) {
        return address != null && address.getAddress() != null && address.getAddress().isLoopbackAddress();
    }

    static boolean anyMatch(String[] values, String needle) {
        return Arrays.stream(values).anyMatch(v -> v.equalsIgnoreCase(needle));
    }
}

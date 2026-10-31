package dev.mcmcp;

import com.google.gson.JsonObject;

public final class ModMethods {
    private ModMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("mod.methods", "The full method catalog (same as GET /methods).", "method catalog",
                Dispatcher.empty(), params -> McmcpMod.dispatcher().catalog());

        d.add("mod.ping", "Round-trip check.", "{\"pong\":true,\"time\":n}",
                Dispatcher.empty(), params -> Json.object("pong", true, "time", System.currentTimeMillis()));

        d.add("mod.log", "Write a line to the game log (level: info, warn, error).", "{\"logged\":true}",
                Dispatcher.params(
                        "message", Dispatcher.param("string", true, "text to log"),
                        "level", Dispatcher.param("string", false, "info (default), warn or error")),
                params -> {
                    String message = Args.requireString(params, "message");
                    String level = Args.string(params, "level", "info").toLowerCase(java.util.Locale.ROOT);
                    switch (level) {
                        case "warn", "warning" -> McmcpMod.LOGGER.warn("[mcmcp] {}", message);
                        case "error" -> McmcpMod.LOGGER.error("[mcmcp] {}", message);
                        default -> McmcpMod.LOGGER.info("[mcmcp] {}", message);
                    }
                    return Json.object("logged", true);
                });

        d.add("mod.config", "The effective mod configuration (host, port, token file, allowRemote).",
                "{\"host\",\"port\",\"tokenFile\",\"allowRemote\"}",
                Dispatcher.empty(), params -> {
                    Config config = McmcpMod.config();
                    if (config == null) throw Args.state("the mod is not initialised");
                    return Json.object(
                            "host", config.host,
                            "port", McmcpMod.server() == null ? config.port : McmcpMod.server().port(),
                            "tokenFile", config.tokenFile,
                            "allowRemote", config.allowRemote);
                });
    }
}

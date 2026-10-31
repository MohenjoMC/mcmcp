package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The method catalog. Handlers run on the client thread; a handler may return a
 * {@link CompletableFuture} when it has to wait for ticks (walk, moveTo, waitFor),
 * in which case the HTTP thread keeps waiting while the game keeps rendering.
 */
public final class Dispatcher {
    @FunctionalInterface
    public interface Handler {
        Object handle(JsonObject params) throws Exception;
    }

    public record Method(String name, String summary, JsonObject params, String returns, Handler handler) {
    }

    private final Map<String, Method> methods = new LinkedHashMap<>();

    public void add(String name, String summary, String returns, JsonObject params, Handler handler) {
        methods.put(name, new Method(name, summary, params, returns, handler));
    }

    public Method method(String name) {
        return methods.get(name);
    }

    public JsonArray catalog() {
        JsonArray array = new JsonArray();
        for (Method method : methods.values()) {
            JsonObject json = new JsonObject();
            json.addProperty("name", method.name());
            json.addProperty("summary", method.summary());
            json.add("params", method.params());
            json.addProperty("returns", method.returns());
            array.add(json);
        }
        return array;
    }

    /**
     * Runs a method on the client thread and flattens a returned future. The
     * returned future completes with the JSON result.
     */
    @SuppressWarnings("unchecked")
    public CompletableFuture<JsonElement> call(String name, JsonObject params) {
        Method method = methods.get(name);
        if (method == null) {
            return CompletableFuture.failedFuture(new McmcpException(-32601, "unknown method '" + name + "'",
                    Json.object("method", name)));
        }
        return McmcpMod.onClient(() -> method.handler().handle(params))
                .thenCompose(result -> {
                    if (result instanceof CompletableFuture<?> future) {
                        return future.thenApply(value -> Json.element((Object) value));
                    }
                    return CompletableFuture.completedFuture(Json.element(result));
                });
    }

    /** {"type":"string","required":true,"description":"..."} */
    public static JsonObject param(String type, boolean required, String description) {
        JsonObject json = new JsonObject();
        json.addProperty("type", type);
        json.addProperty("required", required);
        json.addProperty("description", description);
        return json;
    }

    /** Convenience builder: name, param, name, param, ... */
    public static JsonObject params(Object... pairs) {
        JsonObject json = new JsonObject();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            json.add(String.valueOf(pairs[i]), (JsonObject) pairs[i + 1]);
        }
        return json;
    }

    public static JsonObject empty() {
        return new JsonObject();
    }
}

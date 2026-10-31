package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Parameter helpers. Failures carry the JSON-RPC invalid-params code. */
public final class Args {
    private Args() {
    }

    public static JsonObject object(JsonObject params, String name) {
        JsonElement value = params.get(name);
        if (value == null || !value.isJsonObject()) throw invalid(name, "must be an object");
        return value.getAsJsonObject();
    }

    public static JsonObject objectOr(JsonObject params, String name, JsonObject fallback) {
        JsonElement value = params.get(name);
        return value == null || !value.isJsonObject() ? fallback : value.getAsJsonObject();
    }

    public static String requireString(JsonObject params, String name) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) {
            throw invalid(name, "is required");
        }
        return value.getAsString();
    }

    public static String string(JsonObject params, String name, String fallback) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull()) return fallback;
        return value.getAsString();
    }

    public static int requireInt(JsonObject params, String name) {
        JsonElement value = params.get(name);
        if (value == null || !value.isJsonPrimitive()) throw invalid(name, "is required");
        return value.getAsInt();
    }

    public static int integer(JsonObject params, String name, int fallback) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull()) return fallback;
        return value.getAsInt();
    }

    public static long longValue(JsonObject params, String name, long fallback) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull()) return fallback;
        return value.getAsLong();
    }

    public static double requireDouble(JsonObject params, String name) {
        JsonElement value = params.get(name);
        if (value == null || !value.isJsonPrimitive()) throw invalid(name, "is required");
        return value.getAsDouble();
    }

    public static double number(JsonObject params, String name, double fallback) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull()) return fallback;
        return value.getAsDouble();
    }

    public static boolean bool(JsonObject params, String name, boolean fallback) {
        JsonElement value = params.get(name);
        if (value == null || value.isJsonNull()) return fallback;
        return value.getAsBoolean();
    }

    public static JsonArray requireArray(JsonObject params, String name) {
        JsonElement value = params.get(name);
        if (value == null || !value.isJsonArray()) throw invalid(name, "must be an array");
        return value.getAsJsonArray();
    }

    public static boolean has(JsonObject params, String name) {
        JsonElement value = params.get(name);
        return value != null && !value.isJsonNull();
    }

    public static McmcpException invalid(String name, String why) {
        return new McmcpException(-32602, "parameter '" + name + "' " + why, Json.object("parameter", name));
    }

    public static McmcpException state(String message) {
        return new McmcpException(-32000, message);
    }

    public static McmcpException unavailable(String what) {
        return new McmcpException(-32003, what + " is not available on this Minecraft version");
    }
}

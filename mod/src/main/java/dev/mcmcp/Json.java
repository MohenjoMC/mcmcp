package dev.mcmcp;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.lang.reflect.Array;
import java.util.Collection;
import java.util.Map;

/** Small JSON helpers on top of the Gson that ships with Minecraft. */
public final class Json {
    public static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    private Json() {
    }

    public static JsonElement element(Object value) {
        if (value == null) return JsonNull.INSTANCE;
        if (value instanceof JsonElement json) return json;
        if (value instanceof JsonObject || value instanceof JsonArray) return (JsonElement) value;
        if (value instanceof String s) return new com.google.gson.JsonPrimitive(s);
        if (value instanceof Number n) return new com.google.gson.JsonPrimitive(n);
        if (value instanceof Boolean b) return new com.google.gson.JsonPrimitive(b);
        if (value instanceof Character c) return new com.google.gson.JsonPrimitive(c);
        if (value instanceof Enum<?> e) return new com.google.gson.JsonPrimitive(e.name().toLowerCase(java.util.Locale.ROOT));
        if (value instanceof Map<?, ?> map) {
            JsonObject obj = new JsonObject();
            map.forEach((k, v) -> obj.add(String.valueOf(k), element(v)));
            return obj;
        }
        if (value instanceof Collection<?> collection) {
            JsonArray array = new JsonArray();
            collection.forEach(v -> array.add(element(v)));
            return array;
        }
        if (value.getClass().isArray()) {
            JsonArray array = new JsonArray();
            int length = Array.getLength(value);
            for (int i = 0; i < length; i++) array.add(element(Array.get(value, i)));
            return array;
        }
        return GSON.toJsonTree(value);
    }

    public static JsonObject object(Object... pairs) {
        JsonObject json = new JsonObject();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            json.add(String.valueOf(pairs[i]), element(pairs[i + 1]));
        }
        return json;
    }

    public static JsonArray array(Object... values) {
        JsonArray array = new JsonArray();
        for (Object value : values) array.add(element(value));
        return array;
    }
}

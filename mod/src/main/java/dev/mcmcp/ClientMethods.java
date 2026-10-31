package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.OptionInstance;
import net.minecraft.client.Options;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/** Client settings, key binds, window actions and screenshots. */
public final class ClientMethods {
    private static final Set<String> SKIP_OPTIONS = Set.of(
            "keyMappings", "resourcePacks", "incompatibleResourcePacks", "modelParts",
            "overrideWidth", "overrideHeight", "fullscreenVideoModeString", "tutorialStep",
            "joinedFirstServer", "serverRenderDistance", "isApplyingGraphicsPreset", "lastServer");

    private ClientMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("client.options.list", "Every client option (render distance, FOV, gamma, GUI scale, …) as key/value/type.",
                "[{\"key\",\"value\",\"type\",\"group\"}]",
                Dispatcher.params("group", Dispatcher.param("string", false, "options (default) or keybinds")),
                params -> {
                    String group = Args.string(params, "group", "options");
                    if (group.equalsIgnoreCase("keybinds")) return keybindList(Game.client());
                    JsonArray array = new JsonArray();
                    for (Map.Entry<String, Field> entry : optionFields().entrySet()) {
                        try {
                            JsonObject json = new JsonObject();
                            Object value = readOption(entry.getValue(), Game.client().options);
                            json.addProperty("key", entry.getKey());
                            json.add("value", Json.element(value));
                            json.addProperty("type", typeName(value));
                            json.addProperty("group", "options");
                            array.add(json);
                        } catch (ReflectiveOperationException | RuntimeException ignored) {
                            // an option that cannot be read is simply not listed
                        }
                    }
                    return array;
                });

        d.add("client.options.get", "Read one option by key.", "{\"key\",\"value\",\"type\"}",
                Dispatcher.params("key", Dispatcher.param("string", true, "option key from client.options.list")),
                params -> {
                    String key = Args.requireString(params, "key");
                    Field field = optionFields().get(key);
                    if (field == null) throw Args.invalid("key", "is not an option; use client.options.list");
                    Object value = readOption(field, Game.client().options);
                    return Json.object("key", key, "value", value, "type", typeName(value));
                });

        d.add("client.options.set", "Change one client option and persist options.txt.",
                "{\"key\",\"value\",\"previous\"}",
                Dispatcher.params(
                        "key", Dispatcher.param("string", true, "option key from client.options.list"),
                        "value", Dispatcher.param("any", true, "new value (boolean, number or string)")),
                params -> {
                    String key = Args.requireString(params, "key");
                    Field field = optionFields().get(key);
                    if (field == null) throw Args.invalid("key", "is not an option; use client.options.list");
                    Minecraft client = Game.client();
                    JsonElement raw = params.get("value");
                    Object previous = readOption(field, client.options);
                    Object next = coerce(raw, previous);
                    try {
                        field.setAccessible(true);
                        Object holder = field.get(client.options);
                        if (holder instanceof OptionInstance<?> instance) {
                            setOption(instance, next);
                        } else {
                            field.set(client.options, next);
                        }
                        client.options.save();
                        if (key.equals("guiScale")) client.resizeGui();
                    } catch (ReflectiveOperationException e) {
                        throw new McmcpException(-32100, "could not set " + key + ": " + e.getMessage());
                    }
                    return Json.object("key", key, "value", next, "previous", previous);
                });

        d.add("client.keybind.list", "Every key bind, including modded ones.", "[{\"action\",\"key\",\"category\",\"defaultKey\"}]",
                Dispatcher.empty(), params -> keybindList(Game.client()));

        d.add("client.keybind.set", "Rebind an action to another key (GLFW name, e.g. W, SPACE, LEFT_SHIFT, MOUSE_RIGHT).",
                "{\"action\",\"key\"}",
                Dispatcher.params(
                        "action", Dispatcher.param("string", true, "translation key from client.keybind.list, e.g. key.jump"),
                        "key", Dispatcher.param("string", true, "new key name")),
                params -> {
                    String action = Args.requireString(params, "action");
                    InputConstants.Key key = Inputs.parseKey(Args.requireString(params, "key"));
                    KeyMapping mapping = findKeybind(action);
                    mapping.setKey(key);
                    KeyMapping.resetMapping();
                    Game.client().options.save();
                    return Json.object("action", action, "key", mapping.saveString());
                });

        d.add("client.keybind.press", "Press and release a bound action (e.g. key.jump, key.sprint, key.attack).",
                "{\"action\",\"held\"}",
                Dispatcher.params(
                        "action", Dispatcher.param("string", true, "translation key from client.keybind.list"),
                        "holdMs", Dispatcher.param("integer", false, "how long to hold, default 50 ms")),
                params -> {
                    KeyMapping mapping = findKeybind(Args.requireString(params, "action"));
                    int holdMs = Math.max(0, Args.integer(params, "holdMs", 50));
                    InputConstants.Key key = PlayerMethods.keyOf(mapping);
                    if (key == InputConstants.UNKNOWN) throw Args.state("the action " + mapping.getName() + " is unbound");
                    Inputs.key(key, InputConstants.PRESS, 0);
                    int ticks = Math.max(1, (holdMs + 49) / 50);
                    McmcpMod.events().after(ticks, () -> Inputs.key(key, InputConstants.RELEASE, 0));
                    return Json.object("action", mapping.getName(), "held", true, "key", key.getName());
                });

        d.add("client.keybind.release", "Release a bound action that is being held.", "{\"action\",\"held\"}",
                Dispatcher.params("action", Dispatcher.param("string", true, "translation key")),
                params -> {
                    KeyMapping mapping = findKeybind(Args.requireString(params, "action"));
                    Inputs.key(PlayerMethods.keyOf(mapping), InputConstants.RELEASE, 0);
                    return Json.object("action", mapping.getName(), "held", false);
                });

        d.add("client.screenshot", "Capture the current frame to screenshots/<name>.png.", "{\"path\",\"width\",\"height\"}",
                Dispatcher.params("name", Dispatcher.param("string", false, "file name without .png; defaults to a timestamp")),
                params -> screenshot(Args.string(params, "name", null)));

        d.add("client.connect", "Connect to a multiplayer server address.", "{\"connecting\",\"address\"}",
                Dispatcher.params("address", Dispatcher.param("string", true, "host or host:port")),
                params -> {
                    String address = Args.requireString(params, "address");
                    Minecraft client = Game.client();
                    var parsed = ServerAddress.parseString(address);
                    ConnectScreen.startConnecting(client.screen, client, parsed,
                            new ServerData(address, address, ServerData.Type.OTHER), false, null);
                    return Json.object("connecting", true, "address", parsed.toString());
                });

        d.add("client.disconnect", "Leave the current world or server and return to the title screen.",
                "{\"disconnected\":true}",
                Dispatcher.empty(), params -> {
                    Minecraft client = Game.client();
                    if (client.player == null) throw Args.state("not connected to a world");
                    client.disconnectFromWorld(Component.literal("Disconnected by mcmcp"));
                    return Json.object("disconnected", true);
                });

        d.add("client.quit", "Quit the game. The response is sent before the client stops.", "{\"quitting\":true}",
                Dispatcher.empty(), params -> {
                    Minecraft client = Game.client();
                    McmcpMod.events().after(2, client::stop);
                    return Json.object("quitting", true);
                });
    }

    // ---- options reflection -------------------------------------------

    private static Map<String, Field> optionFields() {
        Map<String, Field> out = new LinkedHashMap<>();
        for (Field field : Options.class.getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic()) continue;
            if (SKIP_OPTIONS.contains(field.getName())) continue;
            Class<?> type = field.getType();
            boolean usable = type == OptionInstance.class || type == boolean.class || type == int.class
                    || type == double.class || type == float.class || type == String.class
                    || type == long.class;
            if (!usable) continue;
            field.setAccessible(true);
            out.put(field.getName(), field);
        }
        return out;
    }

    private static Object readOption(Field field, Options options) throws ReflectiveOperationException {
        Object value = field.get(options);
        if (value instanceof OptionInstance<?> instance) return instance.get();
        return value;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void setOption(OptionInstance instance, Object value) {
        instance.set(value);
    }

    private static Object coerce(JsonElement raw, Object previous) {
        if (raw == null || raw.isJsonNull()) throw Args.invalid("value", "is required");
        if (previous instanceof Boolean) {
            if (raw.isJsonPrimitive() && raw.getAsJsonPrimitive().isBoolean()) return raw.getAsBoolean();
            String text = raw.getAsString();
            return Boolean.parseBoolean(text);
        }
        if (previous instanceof Integer) return raw.getAsInt();
        if (previous instanceof Long) return raw.getAsLong();
        if (previous instanceof Double) return raw.getAsDouble();
        if (previous instanceof Float) return raw.getAsFloat();
        if (previous instanceof String) return raw.getAsString();
        if (previous instanceof Enum<?> e) {
            String wanted = raw.getAsString().toUpperCase(Locale.ROOT);
            for (Object constant : e.getDeclaringClass().getEnumConstants()) {
                if (((Enum<?>) constant).name().equalsIgnoreCase(wanted)) return constant;
            }
            throw Args.invalid("value", "must be one of " + Arrays.toString(e.getDeclaringClass().getEnumConstants()));
        }
        return raw.getAsString();
    }

    private static String typeName(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean) return "boolean";
        if (value instanceof Integer) return "int";
        if (value instanceof Long) return "long";
        if (value instanceof Double) return "double";
        if (value instanceof Float) return "float";
        if (value instanceof String) return "string";
        if (value instanceof Enum<?> e) return "enum:" + e.getDeclaringClass().getSimpleName();
        return value.getClass().getSimpleName().toLowerCase(Locale.ROOT);
    }

    // ---- keybinds ------------------------------------------------------

    static JsonArray keybindList(Minecraft client) {
        JsonArray array = new JsonArray();
        List<KeyMapping> mappings = client.options.keyMappings == null
                ? new ArrayList<>()
                : new ArrayList<>(Arrays.asList(client.options.keyMappings));
        if (mappings.isEmpty()) {
            try {
                Field all = KeyMapping.class.getDeclaredField("ALL");
                all.setAccessible(true);
                Object value = all.get(null);
                if (value instanceof Map<?, ?> map) {
                    for (Object entry : map.values()) {
                        if (entry instanceof KeyMapping mapping) mappings.add(mapping);
                    }
                }
            } catch (ReflectiveOperationException ignored) {
            }
        }
        for (KeyMapping mapping : mappings) {
            JsonObject json = new JsonObject();
            json.addProperty("action", mapping.getName());
            json.addProperty("key", mapping.saveString());
            json.addProperty("name", mapping.getTranslatedKeyMessage().getString());
            json.addProperty("defaultKey", mapping.getDefaultKey().getName());
            json.addProperty("unbound", mapping.isUnbound());
            json.addProperty("category", mapping.getCategory().id().toString());
            array.add(json);
        }
        return array;
    }

    static KeyMapping findKeybind(String action) {
        Minecraft client = Game.client();
        if (client.options.keyMappings != null) {
            for (KeyMapping mapping : client.options.keyMappings) {
                if (mapping.getName().equalsIgnoreCase(action)) return mapping;
            }
        }
        try {
            Field all = KeyMapping.class.getDeclaredField("ALL");
            all.setAccessible(true);
            Object value = all.get(null);
            if (value instanceof Map<?, ?> map) {
                for (Object entry : map.values()) {
                    if (entry instanceof KeyMapping mapping && mapping.getName().equalsIgnoreCase(action)) return mapping;
                }
            }
        } catch (ReflectiveOperationException ignored) {
        }
        throw Args.state("no key bind named '" + action + "'; use client.keybind.list");
    }

    // ---- screenshot ----------------------------------------------------

    private static CompletableFuture<JsonObject> screenshot(String name) {
        Minecraft client = Game.client();
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        File dir = new File(client.gameDirectory, "screenshots");
        File target = new File(dir, (name == null || name.isBlank() ? "mcmcp-" + System.currentTimeMillis() : name) + ".png");
        Screenshot.takeScreenshot(client.getMainRenderTarget(), image -> {
            try {
                File parent = target.getParentFile();
                if (parent != null) parent.mkdirs();
                image.writeToFile(target);
                future.complete(Json.object(
                        "path", target.getAbsolutePath(),
                        "width", image.getWidth(),
                        "height", image.getHeight()));
            } catch (Exception e) {
                future.completeExceptionally(new McmcpException(-32100, "screenshot failed: " + e.getMessage()));
            } finally {
                image.close();
            }
        });
        return future;
    }
}

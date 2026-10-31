package dev.mcmcp;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;

/** Raw keyboard, mouse, camera and text input. */
public final class InputMethods {
    private InputMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("input.key", "Send a key event (press, hold down, or release).",
                "{\"key\",\"held\"}",
                Dispatcher.params(
                        "key", Dispatcher.param("string", true, "W, A, S, D, SPACE, ESCAPE, ENTER, F3, MOUSE_LEFT…"),
                        "action", Dispatcher.param("string", false, "press (default), down or up"),
                        "holdMs", Dispatcher.param("integer", false, "for press, how long to hold (default 60 ms)"),
                        "mods", Dispatcher.param("integer", false, "GLFW modifier bitmask")),
                params -> {
                    InputConstants.Key key = Inputs.parseKey(Args.requireString(params, "key"));
                    String action = Args.string(params, "action", "press").toLowerCase(java.util.Locale.ROOT);
                    int mods = Args.integer(params, "mods", 0);
                    switch (action) {
                        case "down", "press_down" -> {
                            Inputs.key(key, InputConstants.PRESS, mods);
                            return Json.object("key", key.getName(), "held", true);
                        }
                        case "up", "release" -> {
                            Inputs.key(key, InputConstants.RELEASE, mods);
                            return Json.object("key", key.getName(), "held", false);
                        }
                        case "press", "tap" -> {
                            Inputs.key(key, InputConstants.PRESS, mods);
                            int holdMs = Math.max(0, Args.integer(params, "holdMs", 60));
                            int ticks = Math.max(1, (holdMs + 49) / 50);
                            McmcpMod.events().after(ticks, () -> Inputs.key(key, InputConstants.RELEASE, mods));
                            return Json.object("key", key.getName(), "held", true, "holdMs", holdMs);
                        }
                        default -> throw Args.invalid("action", "must be press, down or up");
                    }
                });

        d.add("input.mouse", "Click or hold a mouse button, optionally at GUI coordinates.",
                "{\"button\",\"held\"}",
                Dispatcher.params(
                        "button", Dispatcher.param("string", false, "left (default), right, middle, 0..7"),
                        "action", Dispatcher.param("string", false, "click (default), down or up"),
                        "x", Dispatcher.param("number", false, "GUI-scaled x; defaults to the current cursor"),
                        "y", Dispatcher.param("number", false, "GUI-scaled y"),
                        "mods", Dispatcher.param("integer", false, "GLFW modifier bitmask")),
                params -> {
                    int button = parseButton(params.get("button"));
                    String action = Args.string(params, "action", "click").toLowerCase(java.util.Locale.ROOT);
                    double x = Args.number(params, "x", Double.NaN);
                    double y = Args.number(params, "y", Double.NaN);
                    int mods = Args.integer(params, "mods", 0);
                    switch (action) {
                        case "down" -> {
                            Inputs.mouseButton(button, InputConstants.PRESS, x, y, mods);
                            return Json.object("button", button, "held", true);
                        }
                        case "up", "release" -> {
                            Inputs.mouseButton(button, InputConstants.RELEASE, x, y, mods);
                            return Json.object("button", button, "held", false);
                        }
                        case "click" -> {
                            Inputs.mouseButton(button, InputConstants.PRESS, x, y, mods);
                            McmcpMod.events().after(1, () -> Inputs.mouseButton(button, InputConstants.RELEASE, x, y, mods));
                            return Json.object("button", button, "held", false);
                        }
                        default -> throw Args.invalid("action", "must be click, down or up");
                    }
                });

        d.add("input.move", "Turn the camera by a delta in mouse pixels (positive dx turns right, positive dy looks down).",
                "{\"yaw\",\"pitch\"}",
                Dispatcher.params(
                        "dx", Dispatcher.param("number", false, "horizontal delta"),
                        "dy", Dispatcher.param("number", false, "vertical delta")),
                params -> {
                    LocalPlayer player = Game.player();
                    double sensitivity = Game.client().options.sensitivity().get();
                    double factor = sensitivity * 0.6 + 0.2;
                    double scale = factor * factor * factor * 8.0 * 0.15;
                    float yaw = player.getYRot() + (float) (Args.number(params, "dx", 0) * scale);
                    float pitch = player.getXRot() + (float) (Args.number(params, "dy", 0) * scale);
                    return applyLook(player, yaw, pitch);
                });

        d.add("input.scroll", "Scroll the mouse wheel (positive dy scrolls down).", "{}",
                Dispatcher.params(
                        "dy", Dispatcher.param("number", true, "vertical scroll"),
                        "dx", Dispatcher.param("number", false, "horizontal scroll"),
                        "x", Dispatcher.param("number", false, "cursor x"),
                        "y", Dispatcher.param("number", false, "cursor y")),
                params -> {
                    double x = Args.number(params, "x", Double.NaN);
                    double y = Args.number(params, "y", Double.NaN);
                    if (Double.isFinite(x) && Double.isFinite(y)) Inputs.mouseMove(x, y);
                    Inputs.scroll(Args.number(params, "dx", 0), Args.requireDouble(params, "dy"));
                    return new JsonObject();
                });

        d.add("input.text", "Type text into whatever has focus (chat, a text field, a sign…).", "{\"typed\":n}",
                Dispatcher.params("text", Dispatcher.param("string", true, "text to type")),
                params -> {
                    String text = Args.requireString(params, "text");
                    Inputs.typeText(text);
                    return Json.object("typed", text.codePointCount(0, text.length()));
                });

        d.add("input.releaseAll", "Release every key and mouse button currently held.", "{\"released\":true}",
                Dispatcher.empty(), params -> {
                    Inputs.releaseEverything();
                    return Json.object("released", true);
                });
    }

    static JsonObject applyLook(LocalPlayer player, float yaw, float pitch) {
        pitch = Math.max(-90.0f, Math.min(90.0f, pitch));
        player.setYRot(yaw);
        player.setXRot(pitch);
        if (player.connection != null) {
            player.connection.send(new ServerboundMovePlayerPacket.Rot(yaw, pitch, player.onGround(), false));
        }
        return Json.object("yaw", Game.round(yaw), "pitch", Game.round(pitch));
    }

    static int parseButton(com.google.gson.JsonElement element) {
        if (element == null || element.isJsonNull()) return 0;
        if (element.getAsJsonPrimitive().isNumber()) {
            int value = element.getAsInt();
            if (value < 0 || value > 7) throw Args.invalid("button", "must be 0..7");
            return value;
        }
        String name = element.getAsString().toLowerCase(java.util.Locale.ROOT);
        return switch (name) {
            case "left", "lmb", "primary" -> 0;
            case "right", "rmb", "secondary" -> 1;
            case "middle", "mmb", "wheel" -> 2;
            default -> {
                try {
                    int value = Integer.parseInt(name);
                    yield value;
                } catch (NumberFormatException e) {
                    throw Args.invalid("button", "must be left, right, middle or 0..7");
                }
            }
        };
    }
}

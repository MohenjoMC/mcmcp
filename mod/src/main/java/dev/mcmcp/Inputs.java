package dev.mcmcp;

import com.mojang.blaze3d.platform.InputConstants;
import dev.mcmcp.compat.Compat;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec2;

import java.util.Locale;

/**
 * Synthesises input through the same handlers GLFW drives, so keys, mouse and
 * text behave exactly like real devices (including F3 debug keys and keybinds).
 */
public final class Inputs {
    private Inputs() {
    }

    public static InputConstants.Key parseKey(String name) {
        if (name == null || name.isBlank()) throw Args.invalid("key", "is required");
        String raw = name.trim();
        if (raw.contains(".")) {
            InputConstants.Key key = InputConstants.getKey(raw);
            if (key == InputConstants.UNKNOWN) throw Args.invalid("key", "is not a known key name: " + raw);
            return key;
        }
        String upper = raw.toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
        if (upper.startsWith("MOUSE")) {
            int button = switch (upper) {
                case "MOUSE_LEFT", "MOUSE_1", "MOUSE" -> 0;
                case "MOUSE_RIGHT", "MOUSE_2" -> 1;
                case "MOUSE_MIDDLE", "MOUSE_3" -> 2;
                default -> {
                    String digits = upper.replaceAll("[^0-9]", "");
                    yield digits.isEmpty() ? 0 : Integer.parseInt(digits) - 1;
                }
            };
            if (button < 0 || button > 7) throw Args.invalid("key", "mouse buttons are 0..7");
            return InputConstants.Type.MOUSE.getOrCreate(button);
        }
        String mapped = mapName(upper);
        if (mapped == null) throw Args.invalid("key", "is not a known key name: " + raw);
        InputConstants.Key key = InputConstants.getKey("key.keyboard." + mapped);
        if (key == InputConstants.UNKNOWN) throw Args.invalid("key", "is not a known key name: " + raw);
        return key;
    }

    private static String mapName(String upper) {
        if (upper.matches("[A-Z]") || upper.matches("[0-9]")) return upper.toLowerCase(Locale.ROOT);
        if (upper.matches("F([1-9]|1[0-9]|2[0-5])")) return upper.toLowerCase(Locale.ROOT);
        return switch (upper) {
            case "ESC", "ESCAPE" -> "escape";
            case "ENTER", "RETURN", "RET" -> "enter";
            case "TAB" -> "tab";
            case "SPACE", "SPACEBAR" -> "space";
            case "BACKSPACE", "BACK" -> "backspace";
            case "DELETE", "DEL" -> "delete";
            case "INSERT", "INS" -> "insert";
            case "HOME" -> "home";
            case "END" -> "end";
            case "PAGE_UP", "PAGEUP", "PGUP" -> "page.up";
            case "PAGE_DOWN", "PAGEDOWN", "PGDN" -> "page.down";
            case "UP", "ARROW_UP" -> "up";
            case "DOWN", "ARROW_DOWN" -> "down";
            case "LEFT", "ARROW_LEFT" -> "left";
            case "RIGHT", "ARROW_RIGHT" -> "right";
            case "SHIFT", "LEFT_SHIFT", "LSHIFT" -> "left.shift";
            case "RIGHT_SHIFT", "RSHIFT" -> "right.shift";
            case "CTRL", "CONTROL", "LEFT_CONTROL", "LCTRL" -> "left.control";
            case "RIGHT_CONTROL", "RCTRL" -> "right.control";
            case "ALT", "LEFT_ALT", "LALT" -> "left.alt";
            case "RIGHT_ALT", "RALT" -> "right.alt";
            case "SUPER", "LEFT_SUPER", "LWIN", "CMD", "COMMAND" -> "left.super";
            case "CAPSLOCK", "CAPS_LOCK" -> "caps.lock";
            case "GRAVE", "BACKTICK" -> "grave.accent";
            case "MINUS" -> "minus";
            case "EQUALS" -> "equal";
            case "LBRACKET", "LEFT_BRACKET" -> "left.bracket";
            case "RBRACKET", "RIGHT_BRACKET" -> "right.bracket";
            case "BACKSLASH" -> "backslash";
            case "SEMICOLON" -> "semicolon";
            case "APOSTROPHE", "QUOTE" -> "apostrophe";
            case "COMMA" -> "comma";
            case "PERIOD", "DOT" -> "period";
            case "SLASH" -> "slash";
            default -> null;
        };
    }

    public static void key(InputConstants.Key key, int action, int modifiers) {
        if (key == null || key == InputConstants.UNKNOWN) throw Args.invalid("key", "is not a known key name");
        Compat.key(requireClient(), key.getValue(), action, modifiers);
    }

    public static void mouseMove(double x, double y) {
        Compat.mouseMove(requireClient(), x, y);
    }

    public static void mouseButton(int button, int action, double x, double y, int modifiers) {
        Minecraft client = requireClient();
        if (Double.isFinite(x) && Double.isFinite(y)) Compat.mouseMove(client, x, y);
        Compat.mouseButton(client, button, action, modifiers);
    }

    public static void scroll(double dx, double dy) {
        Compat.scroll(requireClient(), dx, dy);
    }

    public static void typeText(String text) {
        Minecraft client = requireClient();
        text.codePoints().forEach(codepoint -> Compat.typeText(client, codepoint));
    }

    public static void releaseEverything() {
        KeyMapping.releaseAll();
        Minecraft client = McmcpMod.mc();
        if (client == null) return;
        for (int button = 0; button < 3; button++) {
            Compat.mouseButton(client, button, InputConstants.RELEASE, 0);
        }
    }

    public static Vec2 rotationTowards(double fromX, double fromY, double fromZ, double toX, double toY, double toZ) {
        double dx = toX - fromX;
        double dy = toY - fromY;
        double dz = toZ - fromZ;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float pitch = (float) (-Math.toDegrees(Math.atan2(dy, horizontal)));
        return new Vec2(pitch, yaw);
    }

    private static Minecraft requireClient() {
        Minecraft client = McmcpMod.mc();
        if (client == null) throw Args.state("the game is not running");
        return client;
    }
}

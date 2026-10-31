package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.advancements.AdvancementsScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.gui.screens.social.SocialInteractionsScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.player.LocalPlayer;

import java.util.Locale;
import java.util.concurrent.CompletableFuture;

/** Screen inspection and widget-level navigation. */
public final class GuiMethods {
    private GuiMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("gui.screen", "The open screen: id, title, and every widget with its id, label and bounds.",
                "{\"id\",\"title\",\"widgets\":[{\"id\",\"type\",\"label\",\"x\",\"y\",\"width\",\"height\",\"active\",\"visible\"}],\"container\"?}",
                Dispatcher.empty(), params -> {
                    Screen screen = McmcpMod.mc().screen;
                    JsonObject json = new JsonObject();
                    if (screen == null) {
                        json.add("id", com.google.gson.JsonNull.INSTANCE);
                        json.add("title", com.google.gson.JsonNull.INSTANCE);
                        json.add("widgets", new JsonArray());
                        return json;
                    }
                    json = Game.screenJson(screen);
                    json.add("widgets", Game.widgets(screen));
                    json.add("lists", Game.lists(screen));
                    if (screen instanceof AbstractContainerScreen<?> container) {
                        json.add("items", Game.containerItems(container));
                    }
                    return json;
                });

        d.add("gui.click", "Click a widget by label (exact beats substring; buttons beat labels), by id from gui.screen, by list row, or at explicit coordinates.",
                "{\"clicked\":{\"id\",\"label\",\"x\",\"y\"},\"screen\":{...}}",
                Dispatcher.params(
                        "label", Dispatcher.param("string", false, "widget text to match"),
                        "id", Dispatcher.param("integer", false, "widget id from gui.screen"),
                        "list", Dispatcher.param("integer", false, "selection list id from gui.screen lists"),
                        "entry", Dispatcher.param("integer", false, "row index inside that list"),
                        "doubleClick", Dispatcher.param("boolean", false, "send a double click (plays a world, opens a pack)"),
                        "x", Dispatcher.param("number", false, "explicit GUI x"),
                        "y", Dispatcher.param("number", false, "explicit GUI y"),
                        "button", Dispatcher.param("integer", false, "0 left (default), 1 right, 2 middle")),
                params -> {
                    Minecraft client = Game.client();
                    Screen screen = Game.screen();
                    int button = Args.integer(params, "button", 0);
                    Integer id = Args.has(params, "id") ? Args.requireInt(params, "id") : null;
                    String label = Args.string(params, "label", null);
                    boolean doubleClick = Args.bool(params, "doubleClick", false);
                    double x;
                    double y;
                    JsonObject clicked = new JsonObject();
                    AbstractWidget widget = null;
                    net.minecraft.client.gui.components.AbstractSelectionList<?> list = null;
                    Object entry = null;

                    if (Args.has(params, "list") || Args.has(params, "entry")) {
                        int listId = Args.requireInt(params, "list");
                        int entryIndex = Args.requireInt(params, "entry");
                        list = Game.listById(screen, listId);
                        entry = entryFor(list, entryIndex);
                        if (!(entry instanceof net.minecraft.client.gui.layouts.LayoutElement row)) {
                            throw Args.state("that list row has no bounds");
                        }
                        x = row.getX() + row.getWidth() / 2.0;
                        y = row.getY() + row.getHeight() / 2.0;
                        clicked.addProperty("id", -1);
                        clicked.addProperty("list", listId);
                        clicked.addProperty("entry", entryIndex);
                        JsonArray labels = new JsonArray();
                        if (entry instanceof net.minecraft.client.gui.layouts.LayoutElement layout) {
                            layout.visitWidgets(w -> {
                                String text = w.getMessage().getString();
                                if (!text.isBlank()) labels.add(text);
                            });
                        }
                        clicked.add("labels", labels);
                    } else if (Args.has(params, "x") && Args.has(params, "y")) {
                        x = Args.requireDouble(params, "x");
                        y = Args.requireDouble(params, "y");
                        clicked.addProperty("id", -1);
                        clicked.addProperty("label", "");
                    } else {
                        if (id == null && label == null) throw Args.invalid("label", "or id (or list+entry, or x and y) is required");
                        Game.FoundWidget found = Game.findWidget(screen, label, id);
                        widget = found.widget();
                        x = widget.getX() + widget.getWidth() / 2.0;
                        y = widget.getY() + widget.getHeight() / 2.0;
                        clicked.addProperty("id", found.id());
                        clicked.addProperty("label", widget.getMessage().getString());
                        clicked.addProperty("type", widget.getClass().getSimpleName());
                    }

                    MouseButtonEvent down = new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0));
                    MouseButtonEvent up = new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0));
                    screen.mouseMoved(x, y);
                    boolean handled;
                    if (list != null /* row click */) {
                        // The list owns hit-testing, selection and double-click handling;
                        // clicking the entry directly never updates the selection.
                        handled = list.mouseClicked(down, doubleClick);
                        list.mouseReleased(up);
                    } else if (widget != null) {
                        // Click the widget itself: a screen-level dispatch can pick a
                        // full-size sibling from a layout and swallow the press.
                        screen.setFocused(widget);
                        widget.setFocused(true);
                        handled = widget.mouseClicked(down, doubleClick);
                        widget.mouseReleased(up);
                    } else {
                        handled = screen.mouseClicked(down, doubleClick);
                        screen.mouseReleased(up);
                    }
                    clicked.addProperty("x", Game.round(x));
                    clicked.addProperty("y", Game.round(y));
                    clicked.addProperty("handled", handled);

                    return waitTicks(2).thenApply(ignored -> {
                        JsonObject out = new JsonObject();
                        out.add("clicked", clicked);
                        out.add("screen", Game.screenJson(client.screen));
                        return out;
                    });
                });

        d.add("gui.type", "Put text into a text field (the first field, or one matched by label/id).",
                "{\"field\":{...},\"value\"}",
                Dispatcher.params(
                        "text", Dispatcher.param("string", true, "text to enter"),
                        "field", Dispatcher.param("string", false, "field label or id"),
                        "clear", Dispatcher.param("boolean", false, "replace the value (default true)")),
                params -> {
                    Screen screen = Game.screen();
                    String label = Args.string(params, "field", null);
                    Integer id = null;
                    if (label != null && label.matches("\\d+") && Args.has(params, "field")) {
                        id = Integer.parseInt(label);
                        label = null;
                    }
                    EditBox box = Game.findEditBox(screen, label, id);
                    String text = Args.requireString(params, "text");
                    boolean clear = Args.bool(params, "clear", true);
                    screen.setFocused(box);
                    box.setFocused(true);
                    box.setValue(clear ? text : box.getValue() + text);
                    JsonObject field = new JsonObject();
                    field.addProperty("label", box.getMessage().getString());
                    field.addProperty("value", box.getValue());
                    return Json.object("field", field, "value", box.getValue());
                });

        d.add("gui.key", "Send a key to the open screen (ESCAPE, ENTER, TAB, arrows, …).", "{\"screen\":{...}}",
                Dispatcher.params(
                        "key", Dispatcher.param("string", true, "key name"),
                        "action", Dispatcher.param("string", false, "press (default) or down/up")),
                params -> {
                    Screen screen = Game.screen();
                    var key = Inputs.parseKey(Args.requireString(params, "key"));
                    String action = Args.string(params, "action", "press").toLowerCase(Locale.ROOT);
                    KeyEvent event = new KeyEvent(key.getValue(), 0, 0);
                    if (action.equals("up")) {
                        screen.keyReleased(event);
                    } else {
                        screen.keyPressed(event);
                        if (action.equals("press")) screen.keyReleased(event);
                    }
                    return waitTicks(1).thenApply(ignored -> {
                        JsonObject out = new JsonObject();
                        out.add("screen", Game.screenJson(McmcpMod.mc().screen));
                        return out;
                    });
                });

        d.add("gui.open", "Open a vanilla screen by name.", "{\"screen\":{...}}",
                Dispatcher.params("screen", Dispatcher.param("string", true,
                        "inventory, chat, pause, options, social, advancements, stats")),
                params -> {
                    Minecraft client = Game.client();
                    String name = Args.requireString(params, "screen").toLowerCase(Locale.ROOT);
                    LocalPlayer player = Game.player();
                    Screen next = switch (name) {
                        case "inventory", "inv" -> new InventoryScreen(player);
                        case "chat" -> new ChatScreen("", false);
                        case "pause", "menu", "esc" -> new PauseScreen(true);
                        case "options", "settings" -> new OptionsScreen(client.screen, client.options, client.level != null);
                        case "social", "social_interactions" -> new SocialInteractionsScreen();
                        case "advancements", "advancement" -> new AdvancementsScreen(client.getConnection().getAdvancements());
                        default -> throw Args.invalid("screen", "must be inventory, chat, pause, options, social or advancements");
                    };
                    client.setScreen(next);
                    return waitTicks(2).thenApply(ignored -> {
                        JsonObject out = new JsonObject();
                        out.add("screen", Game.screenJson(client.screen));
                        return out;
                    });
                });

        d.add("gui.close", "Close the open screen.", "{\"screen\":null}",
                Dispatcher.empty(), params -> {
                    Minecraft client = Game.client();
                    if (client.screen == null) return Json.object("screen", null);
                    client.setScreen(null);
                    return waitTicks(1).thenApply(ignored -> Json.object("screen", null));
                });

        d.add("gui.waitFor", "Wait until a screen or a widget label appears (polling each tick).",
                "{\"matched\":true,\"screen\":{...}}",
                Dispatcher.params(
                        "label", Dispatcher.param("string", false, "widget label to wait for"),
                        "screen", Dispatcher.param("string", false, "screen id to wait for"),
                        "timeoutMs", Dispatcher.param("integer", false, "default 5000")),
                params -> {
                    String label = Args.string(params, "label", null);
                    String screenId = Args.string(params, "screen", null);
                    int timeoutMs = Math.min(30_000, Math.max(50, Args.integer(params, "timeoutMs", 5000)));
                    if (label == null && screenId == null) throw Args.invalid("label", "or screen is required");
                    int ticks = Math.max(1, (timeoutMs + 49) / 50);
                    CompletableFuture<JsonObject> future = new CompletableFuture<>();
                    long deadline = System.currentTimeMillis() + timeoutMs;
                    McmcpMod.events().tickUntil(ticks, run -> {
                        if (matches(label, screenId)) {
                            JsonObject out = new JsonObject();
                            out.addProperty("matched", true);
                            out.add("screen", Game.screenJson(McmcpMod.mc().screen));
                            future.complete(out);
                            return true;
                        }
                        if (System.currentTimeMillis() > deadline) {
                            future.completeExceptionally(new McmcpException(-32001,
                                    "timed out waiting for " + (screenId != null ? "screen " + screenId : "label '" + label + "'"),
                                    Json.object("screen", Game.screenJson(McmcpMod.mc().screen))));
                            return true;
                        }
                        return false;
                    });
                    return future;
                });
    }

    private static boolean matches(String label, String screenId) {
        Screen screen = McmcpMod.mc().screen;
        if (screenId != null) {
            String id = screen == null ? "" : screen.getClass().getSimpleName().toLowerCase(Locale.ROOT);
            String title = screen == null ? "" : screen.getTitle().getString().toLowerCase(Locale.ROOT);
            if (!id.contains(screenId.toLowerCase(Locale.ROOT)) && !title.contains(screenId.toLowerCase(Locale.ROOT))) {
                return false;
            }
        }
        if (label != null) {
            if (screen == null) return false;
            for (var listener : screen.children()) {
                if (listener instanceof AbstractWidget widget
                        && widget.getMessage().getString().toLowerCase(Locale.ROOT).contains(label.toLowerCase(Locale.ROOT))) {
                    return true;
                }
            }
            return false;
        }
        return true;
    }

    private static CompletableFuture<Void> waitTicks(int ticks) {
        return McmcpMod.events().after(ticks, () -> {
        });
    }

    private static Object entryFor(net.minecraft.client.gui.components.AbstractSelectionList<?> list, int index) {
        var children = list.children();
        if (index < 0 || index >= children.size()) {
            throw Args.invalid("entry", "must be 0.." + (children.size() - 1));
        }
        return children.get(index);
    }
}

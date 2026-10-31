package dev.mcmcp.compat;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcmcp.Args;
import dev.mcmcp.McmcpException;
import dev.mcmcp.mixin.KeyboardHandlerAccessor;
import dev.mcmcp.mixin.MouseHandlerAccessor;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.ChatFormatting;
import net.minecraft.SharedConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.components.AbstractSelectionList;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;

import java.io.File;
import java.lang.reflect.Method;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Minecraft 1.21.11 compatibility. The input/screen event API matches 26.x, but
 * several accessors still use the older ResourceLocation-style names and the
 * 1.21 command helpers.
 */
@SuppressWarnings("removal")
public final class Compat {
    private Compat() {
    }

    // ---- version / identity -------------------------------------------

    public static String mcVersion() {
        return SharedConstants.getCurrentVersion().name();
    }

    public static String profileName(Player player) {
        return player.getGameProfile().name();
    }

    public static UUID profileId(Player player) {
        return player.getGameProfile().id();
    }

    public static String profileName(com.mojang.authlib.GameProfile profile) {
        return profile.name();
    }

    public static UUID profileId(com.mojang.authlib.GameProfile profile) {
        return profile.id();
    }

    public static String dimensionId(Level level) {
        return level.dimension().identifier().toString();
    }

    public static String biomeId(Level level, BlockPos pos) {
        return level.getBiome(pos).unwrapKey().map(key -> key.identifier().toString()).orElse("unknown");
    }

    public static long dayTime(Level level) {
        return level.getDayTime();
    }

    // ---- screen / chat / render target (26.1 vs 26.2) -----------------

    public static Screen screen(Minecraft client) {
        return client.screen;
    }

    public static void setScreen(Minecraft client, Screen screen) {
        client.setScreen(screen);
    }

    public static ChatComponent chat(Minecraft client) {
        return client.gui.getChat();
    }

    public static RenderTarget mainRenderTarget(Minecraft client) {
        return client.getMainRenderTarget();
    }

    // ---- raw input ----------------------------------------------------

    public static void key(Minecraft client, int keyCode, int action, int modifiers) {
        long window = client.getWindow().handle();
        ((KeyboardHandlerAccessor) client.keyboardHandler)
                .mcmcp$keyPress(window, action, new KeyEvent(keyCode, 0, modifiers));
    }

    public static void typeText(Minecraft client, int codepoint) {
        long window = client.getWindow().handle();
        ((KeyboardHandlerAccessor) client.keyboardHandler).mcmcp$charTyped(window, new CharacterEvent(codepoint, 0));
    }

    public static void mouseMove(Minecraft client, double x, double y) {
        ((MouseHandlerAccessor) client.mouseHandler).mcmcp$onMove(client.getWindow().handle(), x, y);
    }

    public static void mouseButton(Minecraft client, int button, int action, int modifiers) {
        ((MouseHandlerAccessor) client.mouseHandler)
                .mcmcp$onButton(client.getWindow().handle(), new MouseButtonInfo(button, modifiers), action);
    }

    public static void scroll(Minecraft client, double dx, double dy) {
        ((MouseHandlerAccessor) client.mouseHandler).mcmcp$onScroll(client.getWindow().handle(), dx, dy);
    }

    // ---- screen-level input -------------------------------------------

    public static boolean clickWidget(AbstractWidget widget, double x, double y, int button, boolean doubleClick) {
        return widget.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)), doubleClick);
    }

    public static boolean releaseWidget(AbstractWidget widget, double x, double y, int button) {
        return widget.mouseReleased(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)));
    }

    public static boolean clickScreen(Screen screen, double x, double y, int button, boolean doubleClick) {
        return screen.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)), doubleClick);
    }

    public static boolean releaseScreen(Screen screen, double x, double y, int button) {
        return screen.mouseReleased(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)));
    }

    public static boolean keyScreen(Screen screen, int keyCode, boolean release, int modifiers) {
        KeyEvent event = new KeyEvent(keyCode, 0, modifiers);
        return release ? screen.keyReleased(event) : screen.keyPressed(event);
    }

    // ---- options / keybinds -------------------------------------------

    public static InputConstants.Key keyOf(KeyMapping mapping) {
        return com.mojang.blaze3d.platform.InputConstants.getKey(mapping.saveString());
    }

    public static String keybindCategory(KeyMapping mapping) {
        return mapping.getCategory().id().toString();
    }

    public static double sensitivity(Minecraft client) {
        return client.options.sensitivity().get();
    }

    public static void clientMessage(Minecraft client, Component message) {
        chat(client).addMessage(message);
    }

    public static void resizeGui(Minecraft client) {
        client.resizeDisplay();
    }

    public static boolean isFullscreen(Minecraft client) {
        return client.getWindow().isFullscreen();
    }

    /**
     * Dropping changed twice in the 26.x line: drop(boolean) in 26.1,
     * drop(ItemStack, boolean, boolean) in 26.2, drop(ItemStack, boolean, Prediction) in 26.3.
     */
    public static void drop(LocalPlayer player, boolean all) {
        player.drop(player.getInventory().getSelectedItem(), all);
    }

    public static Screen optionsScreen(Minecraft client, Screen parent) {
        return new net.minecraft.client.gui.screens.options.OptionsScreen(parent, client.options);
    }

    public static Screen chatScreen() {
        return new ChatScreen("", false);
    }

    // ---- misc ----------------------------------------------------------

    public static void sendLook(LocalPlayer player, float yaw, float pitch) {
        player.setYRot(yaw);
        player.setXRot(pitch);
        if (player.connection != null) {
            player.connection.send(new ServerboundMovePlayerPacket.Rot(yaw, pitch, player.onGround(), false));
        }
    }

    public static CompletableFuture<int[]> screenshot(Minecraft client, File target) {
        CompletableFuture<int[]> future = new CompletableFuture<>();
        Screenshot.takeScreenshot(mainRenderTarget(client), image -> {
            try {
                File parent = target.getParentFile();
                if (parent != null) parent.mkdirs();
                image.writeToFile(target);
                future.complete(new int[]{image.getWidth(), image.getHeight()});
            } catch (Exception e) {
                future.completeExceptionally(e);
            } finally {
                image.close();
            }
        });
        return future;
    }

    // ---- selection lists ----------------------------------------------

    public static boolean isList(Object value) {
        return value instanceof AbstractSelectionList<?>;
    }

    public static int listCount(Screen screen) {
        int count = 0;
        for (var listener : screen.children()) {
            if (listener instanceof AbstractSelectionList<?>) count++;
        }
        return count;
    }

    public static Object listById(Screen screen, int id) {
        int index = 0;
        for (var listener : screen.children()) {
            if (listener instanceof AbstractSelectionList<?>) {
                if (index == id) return listener;
                index++;
            }
        }
        throw Args.state("no selection list with id " + id);
    }

    public static JsonArray lists(Screen screen) {
        JsonArray out = new JsonArray();
        if (screen == null) return out;
        int listIndex = 0;
        for (var listener : screen.children()) {
            if (!(listener instanceof AbstractSelectionList<?> list)) continue;
            JsonObject json = new JsonObject();
            json.addProperty("id", listIndex++);
            json.addProperty("class", list.getClass().getSimpleName());
            JsonArray entries = new JsonArray();
            int index = 0;
            for (Object raw : list.children()) {
                if (!(raw instanceof net.minecraft.client.gui.layouts.LayoutElement entry)) continue;
                JsonObject e = new JsonObject();
                e.addProperty("index", index++);
                e.addProperty("x", entry.getX());
                e.addProperty("y", entry.getY());
                e.addProperty("width", entry.getWidth());
                e.addProperty("height", entry.getHeight());
                JsonArray labels = new JsonArray();
                entry.visitWidgets(widget -> {
                    String text = widget.getMessage().getString();
                    if (!text.isBlank()) labels.add(text);
                });
                e.add("labels", labels);
                String narration = narration(raw);
                if (narration != null) e.addProperty("narration", narration);
                e.addProperty("selected", list.getSelected() == raw);
                entries.add(e);
            }
            json.add("entries", entries);
            out.add(json);
        }
        return out;
    }

    public static Object entryFor(Object list, int index) {
        if (!(list instanceof AbstractSelectionList<?> selection)) {
            throw Args.state("that is not a selection list");
        }
        var children = selection.children();
        if (index < 0 || index >= children.size()) {
            throw Args.invalid("entry", "must be 0.." + (children.size() - 1));
        }
        return children.get(index);
    }

    public static boolean clickList(Object list, double x, double y, int button, boolean doubleClick) {
        if (!(list instanceof AbstractWidget widget)) throw Args.state("that is not a selection list");
        return widget.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)), doubleClick);
    }

    public static boolean releaseList(Object list, double x, double y, int button) {
        if (!(list instanceof AbstractWidget widget)) throw Args.state("that is not a selection list");
        return widget.mouseReleased(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)));
    }

    private static String narration(Object entry) {
        for (String name : new String[]{"getNarrationMessage", "getWorldName", "getServerName"}) {
            try {
                Method method = entry.getClass().getMethod(name);
                Object value = method.invoke(entry);
                if (value instanceof Component component) return component.getString();
                if (value instanceof String text) return text;
            } catch (ReflectiveOperationException ignored) {
                // try the next name
            }
        }
        return null;
    }

    // ---- commands ------------------------------------------------------

    public static void registerClientCommands(
            com.mojang.brigadier.CommandDispatcher<FabricClientCommandSource> dispatcher,
            Supplier<String> statusLine,
            java.util.function.Consumer<Component> feedback) {
        dispatcher.register(ClientCommandManager.literal("mcmcp")
                .executes(context -> {
                    feedback.accept(Component.literal(statusLine.get()));
                    return 1;
                })
                .then(ClientCommandManager.literal("status").executes(context -> {
                    feedback.accept(Component.literal(statusLine.get()));
                    return 1;
                }))
                .then(ClientCommandManager.literal("stop").executes(context -> {
                    feedback.accept(Component.literal("[mcmcp] control server stopped").withStyle(ChatFormatting.YELLOW));
                    dev.mcmcp.McmcpMod.stopServer();
                    return 1;
                })));
    }

    public static boolean hasClientCommand(String root) {
        var dispatcher = ClientCommandManager.getActiveDispatcher();
        return dispatcher != null && dispatcher.getRoot().getChild(root) != null;
    }

    public static boolean runClientCommand(String command) {
        try {
            Class<?> internals = Class.forName("net.fabricmc.fabric.impl.command.client.ClientCommandInternals");
            Method execute = internals.getMethod("executeCommand", String.class);
            return Boolean.TRUE.equals(execute.invoke(null, command));
        } catch (ClassNotFoundException e) {
            throw new McmcpException(-32003, "client command dispatch is unavailable with this Fabric API");
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "client command dispatch failed: " + e.getCause());
        }
    }
}

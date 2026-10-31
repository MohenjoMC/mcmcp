package dev.mcmcp.compat;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcmcp.Args;
import dev.mcmcp.McmcpException;
import dev.mcmcp.mixin.KeyboardHandlerAccessor;
import dev.mcmcp.mixin.MouseHandlerAccessor;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
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
import net.minecraft.client.gui.screens.options.OptionsScreen;
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
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Minecraft 26.x compatibility. 26.1 and 26.2 moved a handful of accessors
 * (screen, chat, render target), so those go through reflection; everything else
 * is the same API for the whole 26.x line.
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
        return level.getOverworldClockTime();
    }

    // ---- screen / chat / render target (26.1 vs 26.2) -----------------

    private static Field screenField;
    private static Method guiScreen;
    private static Method minecraftSetScreen;
    private static Method guiSetScreen;
    private static Method guiGetChat;
    private static Field guiHud;
    private static Method hudGetChat;
    private static Method getMainRenderTarget;
    private static Field gameRendererField;
    private static Method gameRendererTarget;
    private static boolean resolved;

    private static void resolve() {
        if (resolved) return;
        resolved = true;
        try {
            screenField = Minecraft.class.getField("screen");
        } catch (NoSuchFieldException ignored) {
        }
        try {
            guiScreen = Minecraft.class.getField("gui").getType().getMethod("screen");
        } catch (ReflectiveOperationException ignored) {
        }
        try {
            minecraftSetScreen = Minecraft.class.getMethod("setScreen", Screen.class);
        } catch (NoSuchMethodException ignored) {
        }
        try {
            guiSetScreen = Minecraft.class.getField("gui").getType().getMethod("setScreen", Screen.class);
        } catch (ReflectiveOperationException ignored) {
        }
        try {
            guiGetChat = Minecraft.class.getField("gui").getType().getMethod("getChat");
        } catch (ReflectiveOperationException ignored) {
        }
        try {
            guiHud = Minecraft.class.getField("gui").getType().getField("hud");
            hudGetChat = guiHud.getType().getMethod("getChat");
        } catch (ReflectiveOperationException ignored) {
        }
        try {
            getMainRenderTarget = Minecraft.class.getMethod("getMainRenderTarget");
        } catch (NoSuchMethodException ignored) {
        }
        try {
            gameRendererField = Minecraft.class.getField("gameRenderer");
            gameRendererTarget = gameRendererField.getType().getMethod("mainRenderTarget");
        } catch (ReflectiveOperationException ignored) {
        }
    }

    public static Screen screen(Minecraft client) {
        resolve();
        try {
            if (screenField != null) return (Screen) screenField.get(client);
            if (guiScreen != null) return (Screen) guiScreen.invoke(client.gui);
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot read the current screen: " + e);
        }
        throw new McmcpException(-32003, "reading the current screen is not supported on this Minecraft version");
    }

    public static void setScreen(Minecraft client, Screen screen) {
        resolve();
        try {
            if (minecraftSetScreen != null) {
                minecraftSetScreen.invoke(client, screen);
                return;
            }
            if (guiSetScreen != null) {
                guiSetScreen.invoke(client.gui, screen);
                return;
            }
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot change the screen: " + e);
        }
        throw new McmcpException(-32003, "changing the screen is not supported on this Minecraft version");
    }

    public static ChatComponent chat(Minecraft client) {
        resolve();
        try {
            if (guiGetChat != null) return (ChatComponent) guiGetChat.invoke(client.gui);
            if (guiHud != null && hudGetChat != null) {
                return (ChatComponent) hudGetChat.invoke(guiHud.get(client.gui));
            }
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot reach the chat component: " + e);
        }
        throw new McmcpException(-32003, "chat access is not supported on this Minecraft version");
    }

    public static RenderTarget mainRenderTarget(Minecraft client) {
        resolve();
        try {
            if (getMainRenderTarget != null) return (RenderTarget) getMainRenderTarget.invoke(client);
            if (gameRendererField != null && gameRendererTarget != null) {
                return (RenderTarget) gameRendererTarget.invoke(gameRendererField.get(client));
            }
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot reach the main render target: " + e);
        }
        throw new McmcpException(-32003, "screenshots are not supported on this Minecraft version");
    }

    // ---- raw input ----------------------------------------------------

    public static void key(Minecraft client, int keyCode, int action, int modifiers) {
        long window = client.getWindow().handle();
        ((KeyboardHandlerAccessor) client.keyboardHandler)
                .mcmcp$keyPress(window, action, new KeyEvent(keyCode, 0, modifiers));
    }

    public static void typeText(Minecraft client, int codepoint) {
        long window = client.getWindow().handle();
        ((KeyboardHandlerAccessor) client.keyboardHandler).mcmcp$charTyped(window, new CharacterEvent(codepoint));
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
        chat(client).addClientSystemMessage(message);
    }

    public static void resizeGui(Minecraft client) {
        client.resizeGui();
    }

    public static boolean isFullscreen(Minecraft client) {
        try {
            Method method = client.getWindow().getClass().getMethod("isFullscreen");
            return Boolean.TRUE.equals(method.invoke(client.getWindow()));
        } catch (ReflectiveOperationException ignored) {
            return client.options.fullscreen().get();
        }
    }

    /**
     * Dropping changed twice in the 26.x line: drop(boolean) in 26.1,
     * drop(ItemStack, boolean, boolean) in 26.2, drop(ItemStack, boolean, Prediction) in 26.3.
     */
    public static void drop(LocalPlayer player, boolean all) {
        try {
            net.minecraft.world.entity.LivingEntity.class.getMethod("drop", boolean.class).invoke(player, all);
            return;
        } catch (ReflectiveOperationException ignored) {
            // 26.2+
        }
        net.minecraft.world.item.ItemStack stack = player.getInventory().getSelectedItem();
        try {
            net.minecraft.world.entity.LivingEntity.class
                    .getMethod("drop", net.minecraft.world.item.ItemStack.class, boolean.class, boolean.class)
                    .invoke(player, stack, all, false);
            return;
        } catch (ReflectiveOperationException ignored) {
            // 26.3
        }
        try {
            for (Method method : net.minecraft.world.entity.LivingEntity.class.getMethods()) {
                if (!method.getName().equals("drop")) continue;
                Class<?>[] types = method.getParameterTypes();
                if (types.length != 3 || !types[0].equals(net.minecraft.world.item.ItemStack.class)) continue;
                Object third = null;
                if (types[2].isEnum()) {
                    for (Object constant : types[2].getEnumConstants()) {
                        if (((Enum<?>) constant).name().equals("PREDICTED")) third = constant;
                    }
                    if (third == null) third = types[2].getEnumConstants()[0];
                }
                method.invoke(player, stack, all, third);
                return;
            }
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot drop an item on this Minecraft version: " + e.getCause());
        }
        throw new McmcpException(-32003, "dropping items is not supported on this Minecraft version");
    }

    public static Screen optionsScreen(Minecraft client, Screen parent) {
        // 26.1/26.2 take (parent, options, inWorld); 26.3 went back to (parent, options).
        Class<?> screenClass = net.minecraft.client.gui.screens.options.OptionsScreen.class;
        try {
            return (Screen) screenClass
                    .getConstructor(Screen.class, net.minecraft.client.Options.class, boolean.class)
                    .newInstance(parent, client.options, client.level != null);
        } catch (NoSuchMethodException ignored) {
            // fall through to the two-argument constructor
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot open the options screen: " + e.getCause());
        }
        try {
            return (Screen) screenClass
                    .getConstructor(Screen.class, net.minecraft.client.Options.class)
                    .newInstance(parent, client.options);
        } catch (ReflectiveOperationException e) {
            throw new McmcpException(-32100, "cannot open the options screen: " + e.getCause());
        }
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
        dispatcher.register(ClientCommands.literal("mcmcp")
                .executes(context -> {
                    feedback.accept(Component.literal(statusLine.get()));
                    return 1;
                })
                .then(ClientCommands.literal("status").executes(context -> {
                    feedback.accept(Component.literal(statusLine.get()));
                    return 1;
                }))
                .then(ClientCommands.literal("stop").executes(context -> {
                    feedback.accept(Component.literal("[mcmcp] control server stopped").withStyle(ChatFormatting.YELLOW));
                    dev.mcmcp.McmcpMod.stopServer();
                    return 1;
                })));
    }

    public static boolean hasClientCommand(String root) {
        var dispatcher = ClientCommands.getActiveDispatcher();
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

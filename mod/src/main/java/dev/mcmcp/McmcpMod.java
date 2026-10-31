package dev.mcmcp;

import com.google.gson.JsonObject;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import dev.mcmcp.compat.Compat;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;

/**
 * Mod entrypoint. Boots the control server, feeds events, and exposes the small
 * set of helpers the method classes share.
 */
public class McmcpMod implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("mcmcp");
    public static final String VERSION = "1.0.0";
    public static final int CHAT_HISTORY = 500;

    private static McmcpMod instance;
    private static final Events EVENTS = new Events();
    private static final Dispatcher DISPATCHER = new Dispatcher();
    private static final ArrayDeque<JsonObject> CHAT = new ArrayDeque<>();

    private ControlServer server;
    private Config config;
    private long startedAt;
    private Screen lastScreen;
    private boolean screenKnown;

    @Override
    public void onInitializeClient() {
        instance = this;
        startedAt = System.currentTimeMillis();
        config = Config.load(LOGGER);
        String token = config.resolveToken(LOGGER);

        Methods.registerAll(DISPATCHER);
        server = new ControlServer(config, DISPATCHER, EVENTS, token, LOGGER);
        try {
            int port = server.start();
            Config.writeRuntime(port, mcVersion(), VERSION, playerName(), startedAt, LOGGER);
        } catch (IOException e) {
            LOGGER.error("[mcmcp] could not start the control server; the mod stays loaded but is not controllable", e);
            return;
        }

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            EVENTS.onTick();
            detectScreen(client);
        });

        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, timestamp) ->
                recordChat(message.getString(), "chat"));
        ClientReceiveMessageEvents.GAME.register((message, overlay) ->
                recordChat(message.getString(), overlay ? "action" : "system"));

        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            JsonObject data = new JsonObject();
            data.addProperty("world", McmcpMod.worldName());
            data.addProperty("dimension", McmcpMod.dimensionName());
            EVENTS.add("join", data);
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            JsonObject data = new JsonObject();
            data.addProperty("world", McmcpMod.worldName());
            EVENTS.add("leave", data);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> shutdown());

        registerCommands();
        LOGGER.info("[mcmcp] client ready (minecraft {}, loader {})", mcVersion(), loaderVersion());
    }

    private void registerCommands() {
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, access) ->
                Compat.registerClientCommands(dispatcher, McmcpMod::statusLine, McmcpMod::feedback));
    }

    public static String statusLine() {
        ControlServer running = server();
        return "[mcmcp] " + VERSION + " — 127.0.0.1:" + (running == null ? "?" : running.port())
                + " — " + DISPATCHER.catalog().size() + " methods"
                + " | player " + playerName() + " | in world " + inWorld();
    }

    private static void feedback(Component message) {
        Minecraft client = McmcpMod.mc();
        if (client == null) return;
        Compat.clientMessage(client, message);
        JsonObject data = new JsonObject();
        data.addProperty("text", message.getString());
        data.addProperty("kind", "client");
        EVENTS.add("chat", data);
    }

    /** Stops the control server (also used by /mcmcp stop). */
    public static void stopServer() {
        if (instance != null) instance.shutdown();
    }

    private void detectScreen(Minecraft client) {
        Screen screen = Compat.screen(client);
        if (!screenKnown || screen != lastScreen) {
            screenKnown = true;
            lastScreen = screen;
            JsonObject data = new JsonObject();
            if (screen == null) {
                data.add("screen", com.google.gson.JsonNull.INSTANCE);
                data.add("title", com.google.gson.JsonNull.INSTANCE);
            } else {
                data.addProperty("screen", screen.getClass().getSimpleName());
                data.addProperty("title", screen.getTitle().getString());
            }
            EVENTS.add("screen", data);
        }
    }

    private static void recordChat(String text, String kind) {
        JsonObject json = new JsonObject();
        json.addProperty("text", text);
        json.addProperty("kind", kind);
        json.addProperty("time", System.currentTimeMillis());
        synchronized (CHAT) {
            CHAT.addLast(json);
            while (CHAT.size() > CHAT_HISTORY) CHAT.removeFirst();
        }
        JsonObject data = new JsonObject();
        data.addProperty("text", text);
        data.addProperty("kind", kind);
        EVENTS.add("chat", data);
    }

    private void shutdown() {
        if (server != null) {
            server.stop();
            server = null;
        }
        Config.removeRuntime();
    }

    // ---- shared helpers ------------------------------------------------

    public static McmcpMod get() {
        return instance;
    }

    public static Events events() {
        return EVENTS;
    }

    public static Dispatcher dispatcher() {
        return DISPATCHER;
    }

    public static ControlServer server() {
        return instance == null ? null : instance.server;
    }

    public static Config config() {
        return instance == null ? null : instance.config;
    }

    public static Minecraft mc() {
        return Minecraft.getInstance();
    }

    public static <T> CompletableFuture<T> onClient(Callable<T> callable) {
        Minecraft client = Minecraft.getInstance();
        CompletableFuture<T> future = new CompletableFuture<>();
        if (client == null) {
            future.completeExceptionally(new McmcpException(-32000, "the game is not running"));
            return future;
        }
        try {
            client.execute(() -> {
                try {
                    future.complete(callable.call());
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
        } catch (Throwable t) {
            future.completeExceptionally(t);
        }
        return future;
    }

    public static String playerName() {
        Minecraft client = Minecraft.getInstance();
        if (client == null) return null;
        if (client.player != null) return Compat.profileName(client.player);
        if (client.getUser() != null) return client.getUser().getName();
        return null;
    }

    public static boolean inWorld() {
        Minecraft client = Minecraft.getInstance();
        return client != null && client.player != null && client.level != null;
    }

    public static long uptimeMs() {
        return instance == null ? 0 : System.currentTimeMillis() - instance.startedAt;
    }

    public static String mcVersion() {
        return Compat.mcVersion();
    }

    public static String loaderVersion() {
        return FabricLoader.getInstance().getModContainer("fabricloader")
                .map(container -> container.getMetadata().getVersion().getFriendlyString())
                .orElse("unknown");
    }

    public static String fabricApiVersion() {
        return FabricLoader.getInstance().getModContainer("fabric-api")
                .map(container -> container.getMetadata().getVersion().getFriendlyString())
                .orElse("unknown");
    }

    public static String worldName() {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.getCurrentServer() != null) {
            return client != null && client.getCurrentServer() != null ? client.getCurrentServer().ip : null;
        }
        if (client.hasSingleplayerServer() && client.getSingleplayerServer() != null) {
            return client.getSingleplayerServer().getWorldData().getLevelName();
        }
        return null;
    }

    public static String dimensionName() {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.level == null) return null;
        return Compat.dimensionId(client.level);
    }

    public static java.util.List<JsonObject> chatHistory() {
        synchronized (CHAT) {
            return new java.util.ArrayList<>(CHAT);
        }
    }

    public static int clearChat() {
        synchronized (CHAT) {
            int size = CHAT.size();
            CHAT.clear();
            return size;
        }
    }

    public static long ticksToMs(int ticks) {
        return Math.round(ticks * 50.0);
    }
}

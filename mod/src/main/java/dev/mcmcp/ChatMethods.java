package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import dev.mcmcp.mixin.KeyboardHandlerAccessor;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Locale;

/** Chat and command execution. */
public final class ChatMethods {
    private ChatMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("chat.send", "Send a chat message to the server (leading '/' sends a command).",
                "{\"sent\":true,\"message\"}",
                Dispatcher.params("message", Dispatcher.param("string", true, "message text")),
                params -> {
                    String message = Args.requireString(params, "message");
                    var connection = Game.client().getConnection();
                    if (connection == null) throw Args.state("not connected to a server");
                    if (message.startsWith("/")) connection.sendCommand(message.substring(1));
                    else connection.sendChat(message);
                    return Json.object("sent", true, "message", message);
                });

        d.add("chat.history", "Recent chat and system messages seen by this client.", "{\"messages\":[{\"text\",\"kind\",\"time\"}]}",
                Dispatcher.params("limit", Dispatcher.param("integer", false, "default 50, max 500")),
                params -> {
                    int limit = Math.max(1, Math.min(500, Args.integer(params, "limit", 50)));
                    List<JsonObject> all = McmcpMod.chatHistory();
                    JsonArray array = new JsonArray();
                    int from = Math.max(0, all.size() - limit);
                    for (int i = from; i < all.size(); i++) array.add(all.get(i));
                    return Json.object("messages", array);
                });

        d.add("chat.clear", "Clear the visible chat and the history buffer.", "{\"cleared\":n}",
                Dispatcher.empty(), params -> {
                    int cleared = McmcpMod.clearChat();
                    Minecraft client = McmcpMod.mc();
                    if (client != null && client.gui != null) client.gui.getChat().clearMessages(true);
                    return Json.object("cleared", cleared);
                });

        d.add("command.run", "Run a command. Client commands (/nonick, /mcmcp, …) are executed locally; everything else goes to the server.",
                "{\"command\",\"dispatched\":\"client\"|\"server\"}",
                Dispatcher.params(
                        "command", Dispatcher.param("string", true, "command with or without a leading slash"),
                        "clientOnly", Dispatcher.param("boolean", false, "never forward to the server")),
                params -> {
                    String raw = Args.requireString(params, "command").trim();
                    String command = raw.startsWith("/") ? raw.substring(1) : raw;
                    if (command.isEmpty()) throw Args.invalid("command", "is empty");
                    boolean clientOnly = Args.bool(params, "clientOnly", false);
                    if (clientOnly || isClientCommand(command)) {
                        return Json.object("command", command, "dispatched", "client", "result", dispatchClient(command));
                    }
                    var connection = Game.client().getConnection();
                    if (connection == null) throw Args.state("not connected to a server");
                    connection.sendCommand(command);
                    return Json.object("command", command, "dispatched", "server");
                });

        d.add("command.client", "Run a client-side command through the client command dispatcher.", "{\"command\",\"dispatched\":\"client\"}",
                Dispatcher.params("command", Dispatcher.param("string", true, "client command")),
                params -> {
                    String raw = Args.requireString(params, "command").trim();
                    String command = raw.startsWith("/") ? raw.substring(1) : raw;
                    return Json.object("command", command, "dispatched", "client", "result", dispatchClient(command));
                });
    }

    static boolean isClientCommand(String command) {
        CommandDispatcher<FabricClientCommandSource> dispatcher = ClientCommands.getActiveDispatcher();
        if (dispatcher == null) return false;
        String root = command.split("\\s+")[0];
        return dispatcher.getRoot().getChild(root) != null;
    }

    static int dispatchClient(String command) {
        CommandDispatcher<FabricClientCommandSource> dispatcher = ClientCommands.getActiveDispatcher();
        if (dispatcher == null) throw Args.state("the client command dispatcher is not ready (join a world first)");
        try {
            return dispatcher.execute(command, new Source());
        } catch (com.mojang.brigadier.exceptions.CommandSyntaxException e) {
            throw new McmcpException(-32000, e.getMessage());
        }
    }

    /** Minimal command source backed by the running client. */
    static final class Source implements FabricClientCommandSource {
        private final Minecraft client = McmcpMod.mc();

        @Override
        public void sendFeedback(Component message) {
            feedback(message);
        }

        @Override
        public void sendError(Component message) {
            feedback(message);
        }

        private void feedback(Component message) {
            if (client == null) return;
            String text = message.getString();
            if (client.gui != null) client.gui.getChat().addClientSystemMessage(message);
            McmcpMod.events().add("chat", Json.object("text", text, "kind", "client"));
        }

        @Override
        public Minecraft getClient() {
            return client;
        }

        @Override
        public LocalPlayer getPlayer() {
            return client == null ? null : client.player;
        }

        @Override
        public ClientLevel getLevel() {
            return client == null ? null : client.level;
        }

        @Override
        public Vec3 getPosition() {
            LocalPlayer player = getPlayer();
            return player == null ? Vec3.ZERO : player.position();
        }

        @Override
        public Vec2 getRotation() {
            LocalPlayer player = getPlayer();
            return player == null ? Vec2.ZERO : new Vec2(player.getXRot(), player.getYRot());
        }

        @Override
        public String toString() {
            return "mcmcp";
        }

        // Suggestion plumbing: delegate to the client's own provider when connected.
        private net.minecraft.client.multiplayer.ClientSuggestionProvider delegate() {
            if (client == null || client.getConnection() == null) return null;
            return client.getConnection().getSuggestionsProvider();
        }

        @Override
        public net.minecraft.server.permissions.PermissionSet permissions() {
            var provider = delegate();
            return provider == null
                    ? net.minecraft.server.permissions.PermissionSet.NO_PERMISSIONS
                    : provider.permissions();
        }

        @Override
        public java.util.Collection<String> getOnlinePlayerNames() {
            var provider = delegate();
            return provider == null ? java.util.List.of() : provider.getOnlinePlayerNames();
        }

        @Override
        public java.util.Collection<String> getAllTeams() {
            var provider = delegate();
            return provider == null ? java.util.List.of() : provider.getAllTeams();
        }

        @Override
        public java.util.stream.Stream<net.minecraft.resources.Identifier> getAvailableSounds() {
            var provider = delegate();
            return provider == null ? java.util.stream.Stream.empty() : provider.getAvailableSounds();
        }

        @Override
        public java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> customSuggestion(
                com.mojang.brigadier.context.CommandContext<?> context) {
            var provider = delegate();
            return provider == null
                    ? com.mojang.brigadier.suggestion.Suggestions.empty()
                    : provider.customSuggestion(context);
        }

        @Override
        public java.util.Set<net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level>> levels() {
            var provider = delegate();
            return provider == null ? java.util.Set.of() : provider.levels();
        }

        @Override
        public net.minecraft.core.RegistryAccess registryAccess() {
            var provider = delegate();
            return provider == null
                    ? net.minecraft.core.RegistryAccess.EMPTY
                    : provider.registryAccess();
        }

        @Override
        public net.minecraft.world.flag.FeatureFlagSet enabledFeatures() {
            var provider = delegate();
            return provider == null
                    ? net.minecraft.world.flag.FeatureFlagSet.of()
                    : provider.enabledFeatures();
        }

        @Override
        public java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> suggestRegistryElements(
                net.minecraft.resources.ResourceKey<? extends net.minecraft.core.Registry<?>> registry,
                net.minecraft.commands.SharedSuggestionProvider.ElementSuggestionType type,
                com.mojang.brigadier.suggestion.SuggestionsBuilder builder,
                com.mojang.brigadier.context.CommandContext<?> context) {
            var provider = delegate();
            return provider == null
                    ? com.mojang.brigadier.suggestion.Suggestions.empty()
                    : provider.suggestRegistryElements(registry, type, builder, context);
        }
    }
}

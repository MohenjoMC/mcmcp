package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcmcp.compat.Compat;
import net.minecraft.client.Minecraft;

import java.util.List;

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
                    if (client != null) Compat.chat(client).clearMessages(true);
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
        String root = command.split("\\s+")[0];
        return Compat.hasClientCommand(root);
    }

    static int dispatchClient(String command) {
        try {
            return Compat.runClientCommand(command) ? 1 : 0;
        } catch (McmcpException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new McmcpException(-32000, e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }
}

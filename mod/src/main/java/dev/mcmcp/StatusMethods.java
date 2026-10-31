package dev.mcmcp;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.PlayerInfo;

public final class StatusMethods {
    private StatusMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("status", "Version, player, world, screen and performance snapshot of this client.",
                "{\"modVersion\",\"mcVersion\",\"loaderVersion\",\"fabricApiVersion\",\"player\":{\"name\",\"uuid\"},\"inWorld\",\"screen\":{\"id\",\"title\"},\"fps\",\"ping\",\"uptimeMs\",\"port\"}",
                Dispatcher.empty(), params -> {
                    Minecraft client = Game.client();
                    JsonObject out = new JsonObject();
                    out.addProperty("ok", true);
                    out.addProperty("modVersion", McmcpMod.VERSION);
                    out.addProperty("mcVersion", McmcpMod.mcVersion());
                    out.addProperty("loaderVersion", McmcpMod.loaderVersion());
                    out.addProperty("fabricApiVersion", McmcpMod.fabricApiVersion());

                    JsonObject player = new JsonObject();
                    player.addProperty("name", McmcpMod.playerName());
                    player.addProperty("uuid", client.player == null ? null : client.player.getUUID().toString());
                    out.add("player", player);

                    out.addProperty("inWorld", client.player != null && client.level != null);
                    out.add("screen", Game.screenJson(client.screen));
                    out.addProperty("fps", client.getFps());
                    out.addProperty("ping", ping(client));
                    out.addProperty("uptimeMs", McmcpMod.uptimeMs());
                    out.addProperty("port", McmcpMod.server() == null ? -1 : McmcpMod.server().port());
                    out.addProperty("world", McmcpMod.worldName());
                    out.addProperty("dimension", McmcpMod.dimensionName());
                    return out;
                });

        d.add("client.window", "Window size, GUI scale and focus state.", "{\"width\",\"height\",\"guiScale\",\"fullscreen\",\"focused\"}",
                Dispatcher.empty(), params -> {
                    Minecraft client = Game.client();
                    JsonObject out = new JsonObject();
                    out.addProperty("width", client.getWindow().getWidth());
                    out.addProperty("height", client.getWindow().getHeight());
                    out.addProperty("guiWidth", client.getWindow().getGuiScaledWidth());
                    out.addProperty("guiHeight", client.getWindow().getGuiScaledHeight());
                    out.addProperty("guiScale", client.getWindow().getGuiScale());
                    out.addProperty("fullscreen", client.getWindow().isFullscreen());
                    out.addProperty("focused", true);
                    return out;
                });
    }

    static int ping(Minecraft client) {
        if (client.player == null || client.getConnection() == null) return -1;
        PlayerInfo info = client.getConnection().getPlayerInfo(client.player.getUUID());
        return info == null ? -1 : info.getLatency();
    }
}

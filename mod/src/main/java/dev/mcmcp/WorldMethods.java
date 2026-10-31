package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import dev.mcmcp.compat.Compat;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;

import java.util.Locale;

/** World, blocks, entities and the open container. */
public final class WorldMethods {
    private WorldMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("world.state", "Dimension, clock time, weather, difficulty and biome.", "world state object",
                Dispatcher.empty(), params -> {
                    ClientLevel level = Game.world();
                    JsonObject out = new JsonObject();
                    out.addProperty("dimension", Compat.dimensionId(level));
                    long clock = Compat.dayTime(level);
                    long dayTime = Math.floorMod(clock, 24000L);
                    out.addProperty("time", clock);
                    out.addProperty("dayTime", dayTime);
                    out.addProperty("day", dayTime < 13000L);
                    out.addProperty("dayCount", Math.floorDiv(clock, 24000L));
                    out.addProperty("gameTime", level.getLevelData().getGameTime());
                    out.addProperty("rain", level.isRaining());
                    out.addProperty("thunder", level.isThundering());
                    out.addProperty("skyDarken", level.getSkyDarken());
                    out.addProperty("difficulty", level.getLevelData().getDifficulty().name().toLowerCase(Locale.ROOT));
                    LocalPlayer player = Game.playerOrNull();
                    if (player != null) {
                        BlockPos pos = player.blockPosition();
                        out.addProperty("biome", Compat.biomeId(level, pos));
                        out.add("position", Game.blockPos(pos));
                    }
                    return out;
                });

        d.add("world.block", "Block id and properties at a position.", "{\"id\",\"air\",\"hardness\",\"light\",\"loaded\"}",
                Dispatcher.params(
                        "x", Dispatcher.param("integer", true, "block x"),
                        "y", Dispatcher.param("integer", true, "block y"),
                        "z", Dispatcher.param("integer", true, "block z")),
                params -> {
                    ClientLevel level = Game.world();
                    BlockPos pos = new BlockPos(Args.requireInt(params, "x"), Args.requireInt(params, "y"), Args.requireInt(params, "z"));
                    JsonObject out = new JsonObject();
                    out.add("position", Game.blockPos(pos));
                    boolean loaded = level.hasChunkAt(pos);
                    out.addProperty("loaded", loaded);
                    BlockState state = level.getBlockState(pos);
                    out.addProperty("id", Game.blockId(state));
                    out.addProperty("air", state.isAir());
                    out.addProperty("state", state.toString());
                    if (loaded) {
                        out.addProperty("hardness", Game.round(state.getDestroySpeed(level, pos)));
                        out.addProperty("light", level.getMaxLocalRawBrightness(pos));
                    }
                    return out;
                });

        d.add("world.blocks", "Block ids in a box (inclusive), capped at 32768 positions.", "{\"blocks\":[{\"x\",\"y\",\"z\",\"id\"}],\"truncated\"}",
                Dispatcher.params(
                        "from", Dispatcher.param("object", true, "{x,y,z}"),
                        "to", Dispatcher.param("object", true, "{x,y,z}")),
                params -> {
                    ClientLevel level = Game.world();
                    JsonObject from = Args.object(params, "from");
                    JsonObject to = Args.object(params, "to");
                    int x1 = Args.requireInt(from, "x");
                    int y1 = Args.requireInt(from, "y");
                    int z1 = Args.requireInt(from, "z");
                    int x2 = Args.requireInt(to, "x");
                    int y2 = Args.requireInt(to, "y");
                    int z2 = Args.requireInt(to, "z");
                    int minX = Math.min(x1, x2);
                    int minY = Math.min(y1, y2);
                    int minZ = Math.min(z1, z2);
                    int maxX = Math.max(x1, x2);
                    int maxY = Math.max(y1, y2);
                    int maxZ = Math.max(z1, z2);
                    long volume = (long) (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
                    JsonArray array = new JsonArray();
                    boolean truncated = volume > 32768;
                    BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
                    outer:
                    for (int y = minY; y <= maxY; y++) {
                        for (int z = minZ; z <= maxZ; z++) {
                            for (int x = minX; x <= maxX; x++) {
                                pos.set(x, y, z);
                                if (!level.hasChunkAt(pos)) continue;
                                BlockState state = level.getBlockState(pos);
                                if (state.isAir()) continue;
                                array.add(Json.object("x", x, "y", y, "z", z, "id", Game.blockId(state)));
                                if (array.size() >= 32768) {
                                    truncated = true;
                                    break outer;
                                }
                            }
                        }
                    }
                    return Json.object("blocks", array, "truncated", truncated, "volume", volume);
                });

        d.add("world.entities", "Loaded entities around the player.", "[{\"id\",\"type\",\"name\",\"position\",\"distance\"}]",
                Dispatcher.params(
                        "radius", Dispatcher.param("number", false, "default 64"),
                        "type", Dispatcher.param("string", false, "filter by entity id, e.g. minecraft:zombie")),
                params -> {
                    ClientLevel level = Game.world();
                    LocalPlayer player = Game.player();
                    double radius = Math.max(1.0, Args.number(params, "radius", 64.0));
                    String type = Args.string(params, "type", null);
                    JsonArray array = new JsonArray();
                    for (Entity entity : level.entitiesForRendering()) {
                        if (entity == player) continue;
                        if (entity.distanceTo(player) > radius) continue;
                        String id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
                        if (type != null && !id.contains(type.toLowerCase(Locale.ROOT))) continue;
                        array.add(Game.entityJson(entity, 0));
                    }
                    return array;
                });

        d.add("world.players", "Players in the tab list.", "[{\"name\",\"uuid\",\"ping\",\"gameMode\"}]",
                Dispatcher.empty(), params -> {
                    var connection = Game.client().getConnection();
                    if (connection == null) throw Args.state("not connected to a server");
                    JsonArray array = new JsonArray();
                    for (var info : connection.getOnlinePlayers()) {
                        JsonObject json = new JsonObject();
                        json.addProperty("name", Compat.profileName(info.getProfile()));
                        json.addProperty("uuid", Compat.profileId(info.getProfile()).toString());
                        json.addProperty("ping", info.getLatency());
                        json.addProperty("gameMode", info.getGameMode() == null ? "unknown" : info.getGameMode().getName());
                        var team = info.getTeam();
                        if (team != null) json.addProperty("team", team.getName());
                        array.add(json);
                    }
                    return array;
                });

        d.add("world.raycast", "What the crosshair is pointing at.", "{\"block\":{...}|\"entity\":{...}}",
                Dispatcher.params(
                        "distance", Dispatcher.param("number", false, "reach, default 6"),
                        "entities", Dispatcher.param("boolean", false, "also report the crosshair entity")),
                params -> {
                    Minecraft client = Game.client();
                    LocalPlayer player = Game.player();
                    double distance = Math.max(0.5, Args.number(params, "distance", 6.0));
                    JsonObject out = new JsonObject();
                    HitResult hit = player.pick(distance, 1.0f, false);
                    if (hit.getType() == HitResult.Type.BLOCK && hit instanceof BlockHitResult blockHit) {
                        BlockPos pos = blockHit.getBlockPos();
                        out.add("block", Json.object(
                                "x", pos.getX(), "y", pos.getY(), "z", pos.getZ(),
                                "id", Game.blockId(Game.world().getBlockState(pos)),
                                "side", blockHit.getDirection().getName(),
                                "hit", Json.object("x", Game.round(blockHit.getLocation().x),
                                        "y", Game.round(blockHit.getLocation().y),
                                        "z", Game.round(blockHit.getLocation().z))));
                    }
                    if (Args.bool(params, "entities", false) && client.crosshairPickEntity != null) {
                        Entity entity = client.crosshairPickEntity;
                        if (entity.distanceTo(player) <= distance + 1.0) out.add("entity", Game.entityJson(entity, 0));
                    }
                    out.addProperty("hit", hit.getType().name().toLowerCase(Locale.ROOT));
                    return out;
                });

        d.add("world.container", "Contents of the open container screen, or null.", "{\"title\",\"size\",\"items\":[...]}|null",
                Dispatcher.empty(), params -> {
                    var screen = Compat.screen(McmcpMod.mc());
                    if (!(screen instanceof AbstractContainerScreen<?> container)) return Json.object("container", null);
                    JsonObject out = new JsonObject();
                    out.addProperty("title", container.getTitle().getString());
                    out.addProperty("size", container.getMenu().slots.size());
                    out.add("items", Game.containerItems(container));
                    return out;
                });
    }
}

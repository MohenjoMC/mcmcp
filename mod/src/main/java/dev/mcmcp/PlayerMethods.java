package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.mcmcp.compat.Compat;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

import java.util.Locale;
import java.util.concurrent.CompletableFuture;

/** Movement, interaction and inventory. */
public final class PlayerMethods {
    private PlayerMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("player.state", "Position, rotation, health, hunger, XP, game mode, effects and selected item.",
                "player state object", Dispatcher.empty(), params -> Game.playerState(Game.player()));

        d.add("player.look", "Point the camera at rotations or at a position/entity.", "{\"yaw\",\"pitch\"}",
                Dispatcher.params(
                        "yaw", Dispatcher.param("number", false, "absolute yaw"),
                        "pitch", Dispatcher.param("number", false, "absolute pitch"),
                        "at", Dispatcher.param("object", false, "{x,y,z} to look at"),
                        "entityId", Dispatcher.param("integer", false, "look at this entity")),
                params -> {
                    LocalPlayer player = Game.player();
                    float yaw;
                    float pitch;
                    if (Args.has(params, "entityId")) {
                        Entity entity = entityById(Args.requireInt(params, "entityId"));
                        Vec2 rotation = Inputs.rotationTowards(player.getX(), player.getEyeY(), player.getZ(),
                                entity.getX(), entity.getEyeY(), entity.getZ());
                        yaw = rotation.y;
                        pitch = rotation.x;
                    } else if (Args.has(params, "at")) {
                        JsonObject at = Args.object(params, "at");
                        Vec2 rotation = Inputs.rotationTowards(player.getX(), player.getEyeY(), player.getZ(),
                                Args.requireDouble(at, "x"), Args.requireDouble(at, "y"), Args.requireDouble(at, "z"));
                        yaw = rotation.y;
                        pitch = rotation.x;
                    } else {
                        yaw = (float) Args.number(params, "yaw", player.getYRot());
                        pitch = (float) Args.number(params, "pitch", player.getXRot());
                    }
                    return InputMethods.applyLook(player, yaw, pitch);
                });

        d.add("player.walk", "Hold a movement key for a while (forward/back/left/right).", "{\"moved\",\"position\"}",
                Dispatcher.params(
                        "direction", Dispatcher.param("string", true, "forward, back, left or right"),
                        "ms", Dispatcher.param("integer", false, "how long to walk, default 500 ms"),
                        "sprint", Dispatcher.param("boolean", false, "hold sprint too"),
                        "sneak", Dispatcher.param("boolean", false, "hold sneak too")),
                params -> {
                    LocalPlayer player = Game.player();
                    Minecraft client = Game.client();
                    String direction = Args.requireString(params, "direction").toLowerCase(Locale.ROOT);
                    int ms = Math.max(50, Math.min(30_000, Args.integer(params, "ms", 500)));
                    KeyMapping movement = switch (direction) {
                        case "forward", "up", "w" -> client.options.keyUp;
                        case "back", "backward", "down", "s" -> client.options.keyDown;
                        case "left", "a" -> client.options.keyLeft;
                        case "right", "d" -> client.options.keyRight;
                        default -> throw Args.invalid("direction", "must be forward, back, left or right");
                    };
                    InputConstants.Key key = keyOf(movement);
                    Inputs.key(key, InputConstants.PRESS, 0);
                    InputConstants.Key sprintKey = Args.bool(params, "sprint", false) ? keyOf(client.options.keySprint) : null;
                    InputConstants.Key sneakKey = Args.bool(params, "sneak", false) ? keyOf(client.options.keyShift) : null;
                    if (sprintKey != null) Inputs.key(sprintKey, InputConstants.PRESS, 0);
                    if (sneakKey != null) Inputs.key(sneakKey, InputConstants.PRESS, 0);

                    CompletableFuture<JsonObject> future = new CompletableFuture<>();
                    int ticks = Math.max(1, (ms + 49) / 50);
                    McmcpMod.events().after(ticks, () -> {
                        Inputs.key(key, InputConstants.RELEASE, 0);
                        if (sprintKey != null) Inputs.key(sprintKey, InputConstants.RELEASE, 0);
                        if (sneakKey != null) Inputs.key(sneakKey, InputConstants.RELEASE, 0);
                        JsonObject out = new JsonObject();
                        out.addProperty("moved", true);
                        out.addProperty("direction", direction);
                        out.add("position", Game.position(player));
                        future.complete(out);
                    });
                    return future;
                });

        d.add("player.moveTo", "Walk straight toward a position (looking at it, auto-jump) until close enough or out of time.",
                "{\"arrived\",\"position\",\"distance\"}",
                Dispatcher.params(
                        "x", Dispatcher.param("number", true, "target x"),
                        "y", Dispatcher.param("number", true, "target y"),
                        "z", Dispatcher.param("number", true, "target z"),
                        "tolerance", Dispatcher.param("number", false, "arrive within this distance, default 0.8"),
                        "timeoutMs", Dispatcher.param("integer", false, "default 15000, max 30000"),
                        "sprint", Dispatcher.param("boolean", false, "hold sprint")),
                params -> {
                    double tx = Args.requireDouble(params, "x");
                    double ty = Args.requireDouble(params, "y");
                    double tz = Args.requireDouble(params, "z");
                    double tolerance = Math.max(0.2, Args.number(params, "tolerance", 0.8));
                    int timeoutMs = Math.min(30_000, Math.max(200, Args.integer(params, "timeoutMs", 15_000)));
                    boolean sprint = Args.bool(params, "sprint", false);
                    Minecraft client = Game.client();
                    if (client.player == null) throw Args.state("no player: join a world first");

                    InputConstants.Key forward = keyOf(client.options.keyUp);
                    InputConstants.Key sprintKey = sprint ? keyOf(client.options.keySprint) : null;
                    InputConstants.Key jumpKey = keyOf(client.options.keyJump);
                    InputConstants.Key[] held = {forward, sprintKey};
                    Vec3 target = new Vec3(tx, ty, tz);
                    int maxTicks = timeoutMs / 50;
                    boolean[] pressed = {false};
                    Vec3[] lastPos = {null};
                    CompletableFuture<JsonObject> future = new CompletableFuture<>();

                    McmcpMod.events().tickFor(maxTicks, run -> {
                        LocalPlayer player = Game.playerOrNull();
                        if (player == null) {
                            release(held);
                            future.completeExceptionally(Args.state("the player left the world"));
                            return false;
                        }
                        double distance = Math.sqrt(player.distanceToSqr(target.x, target.y, target.z));
                        if (distance <= tolerance) {
                            release(held);
                            future.complete(result(true, player, distance));
                            return false;
                        }
                        Vec2 rotation = Inputs.rotationTowards(player.getX(), player.getEyeY(), player.getZ(),
                                target.x, target.y + 0.1, target.z);
                        InputMethods.applyLook(player, rotation.y, rotation.x);

                        if (!pressed[0]) {
                            Inputs.key(forward, InputConstants.PRESS, 0);
                            if (sprintKey != null) Inputs.key(sprintKey, InputConstants.PRESS, 0);
                            pressed[0] = true;
                        }

                        boolean needsJump = player.onGround() && target.y > player.getY() + 0.7;
                        if (!needsJump && run % 10 == 0) {
                            if (lastPos[0] != null && lastPos[0].distanceTo(player.position()) < 0.25) needsJump = true;
                            lastPos[0] = player.position();
                        }
                        if (needsJump) {
                            Inputs.key(jumpKey, InputConstants.PRESS, 0);
                            McmcpMod.events().after(2, () -> Inputs.key(jumpKey, InputConstants.RELEASE, 0));
                        }

                        if (run + 1 >= maxTicks) {
                            release(held);
                            future.complete(result(false, player, distance));
                            return false;
                        }
                        return true;
                    });
                    return future;
                });

        d.add("player.jump", "Jump once.", "{}",
                Dispatcher.params("holdMs", Dispatcher.param("integer", false, "default 100 ms")),
                params -> {
                    Minecraft client = Game.client();
                    Game.player();
                    InputConstants.Key key = keyOf(client.options.keyJump);
                    Inputs.key(key, InputConstants.PRESS, 0);
                    int ticks = Math.max(1, (Args.integer(params, "holdMs", 100) + 49) / 50);
                    McmcpMod.events().after(ticks, () -> Inputs.key(key, InputConstants.RELEASE, 0));
                    return Json.object("jumped", true);
                });

        d.add("player.sneak", "Toggle sneaking (shift).", "{\"sneaking\":bool}",
                Dispatcher.params("state", Dispatcher.param("boolean", true, "true to sneak, false to stand")),
                params -> {
                    Minecraft client = Game.client();
                    Game.player();
                    boolean state = Args.bool(params, "state", true);
                    Inputs.key(keyOf(client.options.keyShift), state ? InputConstants.PRESS : InputConstants.RELEASE, 0);
                    return Json.object("sneaking", state);
                });

        d.add("player.sprint", "Toggle sprinting.", "{\"sprinting\":bool}",
                Dispatcher.params("state", Dispatcher.param("boolean", true, "true to sprint, false to stop")),
                params -> {
                    Minecraft client = Game.client();
                    Game.player();
                    boolean state = Args.bool(params, "state", true);
                    Inputs.key(keyOf(client.options.keySprint), state ? InputConstants.PRESS : InputConstants.RELEASE, 0);
                    return Json.object("sprinting", state);
                });

        d.add("player.attack", "Attack the entity in front of you, or a specific entity id.", "{\"attacked\",\"entityId\"?}",
                Dispatcher.params(
                        "entityId", Dispatcher.param("integer", false, "entity id from world.entities"),
                        "holdMs", Dispatcher.param("integer", false, "how long to hold attack, default 80 ms")),
                params -> {
                    Minecraft client = Game.client();
                    LocalPlayer player = Game.player();
                    if (Args.has(params, "entityId")) {
                        Entity entity = entityById(Args.requireInt(params, "entityId"));
                        if (entity.distanceTo(player) > 6.0) throw Args.state("the entity is too far away to attack");
                        Vec2 rotation = Inputs.rotationTowards(player.getX(), player.getEyeY(), player.getZ(),
                                entity.getX(), entity.getEyeY(), entity.getZ());
                        InputMethods.applyLook(player, rotation.y, rotation.x);
                        if (client.gameMode == null) throw Args.state("no game mode (not in a world)");
                        client.gameMode.attack(player, entity);
                        return Json.object("attacked", true, "entityId", entity.getId());
                    }
                    InputConstants.Key key = keyOf(client.options.keyAttack);
                    Inputs.key(key, InputConstants.PRESS, 0);
                    int ticks = Math.max(1, (Args.integer(params, "holdMs", 80) + 49) / 50);
                    McmcpMod.events().after(ticks, () -> Inputs.key(key, InputConstants.RELEASE, 0));
                    return Json.object("attacked", true);
                });

        d.add("player.use", "Use the held item / right-click. holdMs > 0 charges and releases (eating, bows).",
                "{\"used\":true}",
                Dispatcher.params(
                        "hand", Dispatcher.param("string", false, "main (default) or off"),
                        "holdMs", Dispatcher.param("integer", false, "hold before releasing, default 0")),
                params -> {
                    Minecraft client = Game.client();
                    LocalPlayer player = Game.player();
                    if (client.gameMode == null) throw Args.state("no game mode (not in a world)");
                    InteractionHand hand = Args.string(params, "hand", "main").toLowerCase(Locale.ROOT).startsWith("off")
                            ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
                    int holdMs = Math.max(0, Args.integer(params, "holdMs", 0));
                    if (holdMs == 0) {
                        client.gameMode.useItem(player, hand);
                        return Json.object("used", true, "hand", hand.name().toLowerCase(Locale.ROOT));
                    }
                    InputConstants.Key key = keyOf(client.options.keyUse);
                    Inputs.key(key, InputConstants.PRESS, 0);
                    int ticks = Math.max(1, (holdMs + 49) / 50);
                    McmcpMod.events().after(ticks, () -> {
                        Inputs.key(key, InputConstants.RELEASE, 0);
                        client.gameMode.releaseUsingItem(player);
                    });
                    return Json.object("used", true, "hand", hand.name().toLowerCase(Locale.ROOT), "holdMs", holdMs);
                });

        d.add("player.select", "Select a hotbar slot, or the hotbar slot holding an item.", "{\"selectedSlot\",\"item\"}",
                Dispatcher.params(
                        "slot", Dispatcher.param("integer", false, "0..8"),
                        "name", Dispatcher.param("string", false, "item id or display name to search the hotbar for")),
                params -> {
                    LocalPlayer player = Game.player();
                    int slot;
                    if (Args.has(params, "slot")) {
                        slot = Args.requireInt(params, "slot");
                        if (slot < 0 || slot > 8) throw Args.invalid("slot", "must be 0..8");
                    } else if (Args.has(params, "name")) {
                        slot = findHotbarSlot(Args.requireString(params, "name"));
                    } else {
                        throw Args.invalid("slot", "or name is required");
                    }
                    player.getInventory().setSelectedSlot(slot);
                    ItemStack stack = player.getInventory().getSelectedItem();
                    return Json.object("selectedSlot", slot, "item", Game.itemJson(stack, slot));
                });

        d.add("player.drop", "Drop the held item, or the whole stack.", "{\"dropped\":true}",
                Dispatcher.params("all", Dispatcher.param("boolean", false, "drop the whole stack")),
                params -> {
                    LocalPlayer player = Game.player();
                    boolean all = Args.bool(params, "all", false);
                    Compat.drop(player, all);
                    return Json.object("dropped", true, "all", all);
                });

        d.add("player.inventory", "Hotbar, main inventory, armour and offhand contents.", "{\"selectedSlot\",\"hotbar\",\"main\",\"armor\",\"offhand\"}",
                Dispatcher.empty(), params -> {
                    LocalPlayer player = Game.player();
                    var inventory = player.getInventory();
                    JsonObject out = new JsonObject();
                    out.addProperty("selectedSlot", inventory.getSelectedSlot());
                    JsonArray hotbar = new JsonArray();
                    for (int i = 0; i < 9; i++) hotbar.add(Game.itemJson(inventory.getItem(i), i));
                    JsonArray main = new JsonArray();
                    for (int i = 9; i < 36; i++) main.add(Game.itemJson(inventory.getItem(i), i));
                    JsonArray armor = new JsonArray();
                    for (int i = 36; i < 40; i++) armor.add(Game.itemJson(inventory.getItem(i), i));
                    out.add("hotbar", hotbar);
                    out.add("main", main);
                    out.add("armor", armor);
                    out.add("offhand", Game.itemJson(inventory.getItem(40), 40));
                    return out;
                });

        d.add("player.respawn", "Respawn after death.", "{\"respawned\":true}",
                Dispatcher.empty(), params -> {
                    LocalPlayer player = Game.player();
                    player.respawn();
                    return Json.object("respawned", true);
                });
    }

    // ---- helpers -------------------------------------------------------

    static InputConstants.Key keyOf(KeyMapping mapping) {
        return Inputs.parseKey(mapping.saveString());
    }

    static void release(InputConstants.Key[] keys) {
        for (InputConstants.Key key : keys) {
            if (key != null) Inputs.key(key, InputConstants.RELEASE, 0);
        }
    }

    static JsonObject result(boolean arrived, LocalPlayer player, double distance) {
        JsonObject out = new JsonObject();
        out.addProperty("arrived", arrived);
        out.add("position", Game.position(player));
        out.addProperty("distance", Game.round(distance));
        return out;
    }

    static Entity entityById(int id) {
        for (Entity entity : Game.world().entitiesForRendering()) {
            if (entity.getId() == id) return entity;
        }
        throw Args.state("no entity with id " + id + " is loaded");
    }

    static int findHotbarSlot(String name) {
        LocalPlayer player = Game.player();
        String needle = name.toLowerCase(Locale.ROOT);
        for (int i = 0; i < 9; i++) {
            ItemStack stack = player.getInventory().getItem(i);
            if (stack.isEmpty()) continue;
            String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
            if (id.toLowerCase(Locale.ROOT).contains(needle)
                    || stack.getHoverName().getString().toLowerCase(Locale.ROOT).contains(needle)) {
                return i;
            }
        }
        throw Args.state("no hotbar item matching '" + name + "'");
    }
}

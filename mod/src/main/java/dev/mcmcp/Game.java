package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import dev.mcmcp.compat.Compat;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

/** Shared state-to-JSON helpers. */
public final class Game {
    private Game() {
    }

    public static Minecraft client() {
        Minecraft client = McmcpMod.mc();
        if (client == null) throw Args.state("the game is not running");
        return client;
    }

    public static LocalPlayer player() {
        LocalPlayer player = client().player;
        if (player == null) throw Args.state("no player: join a world or a server first");
        return player;
    }

    public static LocalPlayer playerOrNull() {
        Minecraft client = McmcpMod.mc();
        return client == null ? null : client.player;
    }

    public static net.minecraft.client.multiplayer.ClientLevel world() {
        var level = client().level;
        if (level == null) throw Args.state("no world loaded");
        return level;
    }

    public static Screen screen() {
        Screen screen = Compat.screen(client());
        if (screen == null) throw Args.state("no screen is open");
        return screen;
    }

    public static JsonObject screenJson(Screen screen) {
        if (screen == null) return null;
        JsonObject json = new JsonObject();
        json.addProperty("id", screen.getClass().getSimpleName());
        json.addProperty("title", screen.getTitle().getString());
        json.addProperty("width", screen.width);
        json.addProperty("height", screen.height);
        if (screen instanceof AbstractContainerScreen<?> container) {
            json.addProperty("container", container.getMenu().getClass().getSimpleName());
            json.addProperty("slots", container.getMenu().slots.size());
        }
        return json;
    }

    public static JsonArray widgets(Screen screen) {
        JsonArray array = new JsonArray();
        if (screen == null) return array;
        int index = 0;
        for (GuiEventListener listener : screen.children()) {
            if (!(listener instanceof AbstractWidget widget)) continue;
            JsonObject json = new JsonObject();
            json.addProperty("id", index++);
            json.addProperty("type", widget.getClass().getSimpleName());
            json.addProperty("class", widget.getClass().getName());
            json.addProperty("label", widget.getMessage().getString());
            json.addProperty("x", widget.getX());
            json.addProperty("y", widget.getY());
            json.addProperty("width", widget.getWidth());
            json.addProperty("height", widget.getHeight());
            json.addProperty("active", widget.active);
            json.addProperty("visible", widget.visible);
            json.addProperty("focused", widget.isFocused());
            if (widget instanceof EditBox box) {
                json.addProperty("value", box.getValue());
            }
            array.add(json);
        }
        return array;
    }

    public record FoundWidget(AbstractWidget widget, int id) {
    }

    public static FoundWidget findWidget(Screen screen, String label, Integer id) {
        int index = 0;
        List<String> labels = new ArrayList<>();
        FoundWidget best = null;
        int bestScore = Integer.MAX_VALUE;
        for (GuiEventListener listener : screen.children()) {
            if (!(listener instanceof AbstractWidget widget)) continue;
            int current = index++;
            if (id != null && id == current) return new FoundWidget(widget, current);
            if (id != null) continue;
            String text = widget.getMessage().getString();
            labels.add(text);
            if (label == null) continue;
            String haystack = text.toLowerCase(java.util.Locale.ROOT);
            String needle = label.toLowerCase(java.util.Locale.ROOT);
            boolean exact = haystack.equals(needle);
            boolean contains = haystack.contains(needle);
            if (!contains) continue;
            // Prefer a clickable, active widget; a plain text label is the last resort.
            boolean actionable = widget.active && widget.visible && !isPlainText(widget);
            int score = (exact ? 0 : 2) + (actionable ? 0 : 1);
            if (score < bestScore) {
                bestScore = score;
                best = new FoundWidget(widget, current);
            }
        }
        if (best != null) return best;
        if (id != null) throw Args.state("no widget with id " + id + " in " + screen.getClass().getSimpleName());
        throw new McmcpException(-32000, "no widget matching '" + label + "' in " + screen.getClass().getSimpleName(),
                Json.object("available", labels));
    }

    private static boolean isPlainText(AbstractWidget widget) {
        String type = widget.getClass().getSimpleName();
        return type.contains("TextWidget") || type.equals("StringWidget") || type.contains("FocusableText");
    }

    public static EditBox findEditBox(Screen screen, String label, Integer id) {
        int index = 0;
        List<String> labels = new ArrayList<>();
        for (GuiEventListener listener : screen.children()) {
            if (!(listener instanceof AbstractWidget widget)) continue;
            int current = index++;
            if (!(widget instanceof EditBox box)) continue;
            if (id != null && id == current) return box;
            if (id == null) {
                labels.add(widget.getMessage().getString());
                if (label == null) return box;
                if (widget.getMessage().getString().toLowerCase(java.util.Locale.ROOT)
                        .contains(label.toLowerCase(java.util.Locale.ROOT))) {
                    return box;
                }
            }
        }
        throw new McmcpException(-32000, "no text field found in " + screen.getClass().getSimpleName(),
                Json.object("available", labels));
    }

    public static JsonObject itemJson(ItemStack stack, int slot) {
        JsonObject json = new JsonObject();
        json.addProperty("slot", slot);
        if (stack == null || stack.isEmpty()) {
            json.addProperty("id", "minecraft:air");
            json.addProperty("count", 0);
            return json;
        }
        json.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        json.addProperty("name", stack.getHoverName().getString());
        json.addProperty("count", stack.getCount());
        json.addProperty("damage", stack.getDamageValue());
        json.addProperty("maxDamage", stack.getMaxDamage());
        return json;
    }

    public static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    public static JsonObject position(Entity entity) {
        return Json.object("x", round(entity.getX()), "y", round(entity.getY()), "z", round(entity.getZ()));
    }

    public static JsonObject blockPos(BlockPos pos) {
        return Json.object("x", pos.getX(), "y", pos.getY(), "z", pos.getZ());
    }

    public static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    public static JsonObject playerState(LocalPlayer player) {
        JsonObject json = new JsonObject();
        json.addProperty("name", Compat.profileName(player));
        json.addProperty("uuid", player.getUUID().toString());
        json.add("position", position(player));
        Vec3 velocity = player.getDeltaMovement();
        json.add("velocity", Json.object("x", round(velocity.x), "y", round(velocity.y), "z", round(velocity.z)));
        json.addProperty("yaw", round(player.getYRot()));
        json.addProperty("pitch", round(player.getXRot()));
        json.addProperty("onGround", player.onGround());
        json.addProperty("health", round(player.getHealth()));
        json.addProperty("maxHealth", round(player.getMaxHealth()));
        json.addProperty("food", player.getFoodData().getFoodLevel());
        json.addProperty("saturation", round(player.getFoodData().getSaturationLevel()));
        json.addProperty("air", player.getAirSupply());
        json.addProperty("maxAir", player.getMaxAirSupply());
        JsonObject xp = new JsonObject();
        xp.addProperty("level", player.experienceLevel);
        xp.addProperty("progress", round(player.experienceProgress));
        json.add("xp", xp);
        var gameMode = client().gameMode;
        json.addProperty("gameMode", gameMode == null ? "unknown" : gameMode.getPlayerMode().getName());
        json.addProperty("dimension", Compat.dimensionId(player.level()));
        json.addProperty("selectedSlot", player.getInventory().getSelectedSlot());
        JsonObject selected = new JsonObject();
        selected.addProperty("id", BuiltInRegistries.ITEM.getKey(player.getInventory().getSelectedItem().getItem()).toString());
        selected.addProperty("name", player.getInventory().getSelectedItem().getHoverName().getString());
        selected.addProperty("count", player.getInventory().getSelectedItem().getCount());
        json.add("selectedItem", selected);
        json.addProperty("sneaking", player.isShiftKeyDown());
        json.addProperty("sprinting", player.isSprinting());
        json.addProperty("flying", player.getAbilities().flying);
        json.addProperty("walking", player.getDeltaMovement().horizontalDistanceSqr() > 0.001);
        json.addProperty("inWater", player.isInWater());
        json.addProperty("onFire", player.isOnFire());
        JsonArray effects = new JsonArray();
        for (MobEffectInstance effect : player.getActiveEffects()) {
            effects.add(Json.object(
                    "id", effect.getEffect().value().getDescriptionId(),
                    "name", effect.getEffect().value().getDisplayName().getString(),
                    "amplifier", effect.getAmplifier(),
                    "duration", effect.getDuration()));
        }
        json.add("effects", effects);
        return json;
    }

    public static JsonObject entityJson(Entity entity, int radius) {
        JsonObject json = new JsonObject();
        json.addProperty("id", entity.getId());
        json.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
        json.addProperty("name", entity.getName().getString());
        json.add("position", position(entity));
        LocalPlayer player = playerOrNull();
        if (player != null) json.addProperty("distance", round(entity.distanceTo(player)));
        if (entity instanceof LivingEntity living) {
            json.addProperty("health", round(living.getHealth()));
        }
        json.addProperty("player", entity instanceof LocalPlayer);
        if (!entity.isAlive()) json.addProperty("alive", false);
        return json;
    }

    public static JsonArray containerItems(AbstractContainerScreen<?> screen) {
        JsonArray array = new JsonArray();
        int index = 0;
        for (Slot slot : screen.getMenu().slots) {
            JsonObject json = itemJson(slot.getItem(), index++);
            json.addProperty("x", slot.x);
            json.addProperty("y", slot.y);
            array.add(json);
        }
        return array;
    }
}

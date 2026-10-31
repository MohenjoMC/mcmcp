package dev.mcmcp.mixin;

import net.minecraft.client.KeyboardHandler;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(KeyboardHandler.class)
public interface KeyboardHandlerAccessor {
    @Invoker("keyPress")
    void mcmcp$keyPress(long window, int action, KeyEvent event);

    @Invoker("charTyped")
    void mcmcp$charTyped(long window, CharacterEvent event);
}

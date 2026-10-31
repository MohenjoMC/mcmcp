package dev.mcmcp.mixin;

import net.minecraft.client.MouseHandler;
import net.minecraft.client.input.MouseButtonInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(MouseHandler.class)
public interface MouseHandlerAccessor {
    @Invoker("onButton")
    void mcmcp$onButton(long window, MouseButtonInfo button, int action);

    @Invoker("onScroll")
    void mcmcp$onScroll(long window, double dx, double dy);

    @Invoker("onMove")
    void mcmcp$onMove(long window, double x, double y);
}

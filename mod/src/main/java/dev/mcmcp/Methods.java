package dev.mcmcp;

/** Registers every method group. */
public final class Methods {
    private Methods() {
    }

    public static void registerAll(Dispatcher d) {
        StatusMethods.register(d);
        ModMethods.register(d);
        ClientMethods.register(d);
        InputMethods.register(d);
        GuiMethods.register(d);
        ChatMethods.register(d);
        PlayerMethods.register(d);
        WorldMethods.register(d);
        EventsMethods.register(d);
    }
}

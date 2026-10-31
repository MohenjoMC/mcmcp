# Architecture

## Why a mod

"Control my Minecraft" can mean three very different things:

1. a headless bot account (Mineflayer) — not your client, not your settings, not your GUI;
2. OS-level input injection (`xdotool`, pyautogui) — blind to game state, breaks on focus
   changes, cannot read a menu or a block;
3. a mod inside the client that exposes the game's own state and input handlers.

mcmcp is (3). The agent drives the client you are logged into. It can read every option,
enumerate the widgets of the open screen, click a button by its label, send a real key
event through `KeyboardHandler`, read the block under your feet, and run a command with
your permissions. That is only possible from inside the JVM.

## Pieces

| piece | language | responsibility |
| --- | --- | --- |
| `mod/` | Java 25, Fabric | HTTP/JSON-RPC control server, 58 methods, event ring buffer, tick scheduler, input bridge |
| `server/` | TypeScript, Node | MCP tool surface, CLI, instance/mod management, OpenCode config |
| `docs/PROTOCOL.md` | — | the contract both sides implement |

Three processes at most: the game (mod), the MCP server spawned by OpenCode, and whatever
you run in a shell. They coordinate through two files and one socket:

```
~/.config/mcmcp/config.json     host, port, token file, allowRemote
~/.config/mcmcp/token           32-byte hex bearer token, 0600
~/.config/mcmcp/clients/<pid>.json   {pid,port,mcVersion,player,startedAt}
```

Discovery is a file per client process, so several clients can run at once; the bridge
picks the newest healthy one (`/health` probe) and ignores descriptors whose PID is gone.
Port collisions are handled by the mod binding the next free port and advertising it.

## Threading

Minecraft is single-threaded; the control server is not.

- HTTP handlers run on a small daemon pool and parse/validate/auth off-thread.
- Every method body is dispatched onto the client thread with `Minecraft.execute(...)`.
- A method that must wait (walk, moveTo, waitFor, screenshot) returns a
  `CompletableFuture`; the HTTP thread waits on it while the game keeps rendering.
  Long waits are driven by `Events.tickFor`, which runs one step per client tick.
- Nothing sleeps on the render thread. Waits are tick-based, timeouts are wall-clock.
- The event ring (2000 entries) is guarded by a monitor; `GET /events` blocks an HTTP
  thread on that monitor and is woken by the next event.

## Input fidelity

Raw input goes through the same handlers GLFW callbacks use:

```
input.key   → KeyboardHandler.keyPress(window, action, KeyEvent)   [mixin @Invoker]
input.text  → KeyboardHandler.charTyped(window, CharacterEvent)    [mixin @Invoker]
input.mouse → MouseHandler.onMove/onButton/onScroll                [mixin @Invoker]
```

That makes F3 debug keys, chat opening, sneaking, inventory drags and mod keybinds behave
exactly as if typed. GUI actions (`gui.click`, `gui.type`, `gui.key`) call the widget and
screen methods directly, because they are deterministic and need no focus juggling:

- `gui.click` resolves the widget (exact label > actionable substring > any substring),
  focuses it, then calls `widget.mouseClicked(MouseButtonEvent, false)` and
  `mouseReleased`. Clicking through `Screen#mouseClicked` was rejected: layout containers
  can return a full-size sibling and swallow the press.
- `gui.type` focuses the `EditBox` and sets its value (the responder fires).
- `gui.key` forwards a `KeyEvent` to the open screen.

## Settings and key binds

`client.options.*` reflects over `Options` fields:

- `OptionInstance<T>` fields are read with `.get()` and written with `.set(value)` after
  coercing to the current value's type (boolean/int/double/float/String/enum);
- plain public fields (`pauseOnLostFocus`, `advancedItemTooltips`, …) are read/written
  directly;
- everything is persisted with `Options#save()` (options.txt), and `guiScale` triggers
  `resizeGui()`.

Key binds come from `Options#keyMappings` (falling back to `KeyMapping.ALL`), so modded
binds are included. A bind is addressed by its translation key (`key.jump`), and a key by
its GLFW name (`W`, `SPACE`, `LEFT_SHIFT`, `MOUSE_RIGHT`, `key.keyboard.f3`).

## Commands

`command.run` checks the Fabric client command dispatcher for the root literal: if it
matches, the command executes client-side against a `FabricClientCommandSource` built on
the running client (feedback is also pushed into the event stream). Otherwise it is sent
to the server with `ClientPacketListener#sendCommand`, i.e. with your permissions.
`command.client` always stays local, which is how `/nonick status` and `/mcmcp status`
are driven.

## Version support

Six targets from one tree:

| target | build | compat family |
| --- | --- | --- |
| 26.1, 26.1.1, 26.1.2 | `fabric-loom` (unobfuscated), Java 25 | `src/versions/26` |
| 26.2, 26.3 | same, Java 25 | `src/versions/26` |
| 1.21.11 | `fabric-loom-remap` + `loom.officialMojangMappings()`, Java 21 | `src/versions/12111` |

`build.gradle` picks the loom plugin from the version prefix, adds
`src/versions/<family>/java` to the main source set, and compiles with
`--release <java_version>`; the whole matrix therefore runs on one JVM 25 (loom itself
refuses to run on 21), while 1.21.11 still gets Java 21 bytecode.

Only two things are version-specific:

1. **`dev.mcmcp.compat.Compat`** — every call that moved between releases: the current
   screen, `setScreen`, the chat component, the main render target, raw key/mouse events,
   widget/screen clicks, key-binding category and key value, the options screen, client
   message injection, GUI resize, look packets, item dropping and the day-time clock.
2. **Mixins** — `KeyboardHandler`/`MouseHandler` invoke signatures differ (event records
   in 26.x and 1.21.11, raw key/scancode/action in older lines), so the accessors live in
   the version source set.

The 26.x family covers three API steps with reflection instead of three source copies:
screens moved from `Minecraft.screen` to `Gui.screen()`, chat from `Gui.getChat()` to
`Gui.hud.getChat()`, the render target from `Minecraft.getMainRenderTarget()` to
`GameRenderer.mainRenderTarget()`, `OptionsScreen` gained and lost a boolean,
`drop(boolean)` became `drop(ItemStack, boolean, boolean)` then
`drop(ItemStack, boolean, Prediction)`, and `Window.isFullscreen()` disappeared. Each is
resolved once, lazily, with a fallback that still works if a name changes again.

1.21.11 is obfuscated, so it gets the remapping plugin and Mojang mappings; its class
names are the same as 26.x (`Identifier`, `name()`, `identifier()`), which keeps its
Compat implementation a small delta from the modern one, plus the 1.21 command helpers
(`ClientCommandManager`) and chat/render-resize names.

Client commands are dispatched through Fabric's internal
`ClientCommandInternals#executeCommand`, accessed reflectively, so the mod does not have
to implement `FabricClientCommandSource` (whose abstract methods differ across versions).

Adding a target (say 26.4) means adding a matrix row and, if an accessor moved, a
fallback in `Compat`.

## Adding a method

1. Register it in one of `mod/src/main/java/dev/mcmcp/*Methods.java` with a summary,
   return description and parameter schema (`Dispatcher.param("type", required, "doc")`).
2. Run it on the client thread (handlers already are), return plain JSON-able values, or a
   `CompletableFuture` if it must wait for ticks.
3. Add a tool in `server/src/tools.ts` that calls it, or reach it through `mc_raw`.
4. Document it in `docs/PROTOCOL.md`.

`GET /methods` and `mc methods` are generated from the registrations, so the catalog can
never drift from the code.

## Failure modes

| symptom | cause |
| --- | --- |
| `no Minecraft client found` | game not running, mod not installed, or token unreadable |
| `401` from the mod | token file differs between mod and CLI (delete it and restart both) |
| `-32003` | method guarded for a newer/older MC API |
| click does nothing | the widget is inactive/covered; inspect with `gui.screen` and click by id |
| moveTo times out | straight-line walking hit a wall or a gap; it is not a pathfinder |

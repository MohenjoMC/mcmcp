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

Minecraft 26.x ships **unobfuscated**: no mappings, no remapping, plain `implementation`
dependencies in loom 1.19. The build defaults to 26.1.2 and every version-dependent name
is confined to the method classes, so a port is a compile-and-fix loop:

```sh
./gradlew build -Pminecraft_version=26.2 -Pfabric_api_version=0.161.0+26.2 \
  -Pminecraft_dependency='~26.2'
```

1.21.11 and older are obfuscated and would need `fabric-loom-remap` plus Yarn/official
mappings, and several names this code uses (`Identifier` vs `ResourceLocation`,
`KeyEvent` records, `getOverworldClockTime`, `GameProfile#name`) do not exist there. The
1.21.x port is a separate branch, not a flag.

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

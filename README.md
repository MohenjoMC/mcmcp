<img src="assets/icon.svg" width="64" height="64" alt="">

# mcmcp

Control a live Minecraft Java client from your agent: every client setting, every
button and screen, keyboard/mouse input, chat, commands, and player/world state —
over one local, token-protected endpoint, exposed as MCP tools and a `mcmcp` CLI.

```
┌──────────────┐   MCP (stdio)   ┌─────────────────┐   HTTP JSON-RPC    ┌──────────────────────┐
│  OpenCode    │ ──────────────► │  mcmcp serve    │ ─────────────────► │  mcmcp mod (Fabric)  │
│  agent       │ ◄────────────── │  (TypeScript)   │ ◄───────────────── │  inside the client   │
└──────────────┘                 └─────────────────┘    127.0.0.1:25585 └──────────────────────┘
        ▲                                 ▲                                        │
        └──────────── mcmcp CLI ──────────┘                       real input handlers, real GUI
```

The mod is not a bot: it drives the game you are actually logged into. Key presses go
through `KeyboardHandler`, clicks through `MouseHandler`, menu actions through the real
`Screen` widgets, so anything a player can do, the agent can do.

- Wire protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- Architecture and version support: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Install

Prerequisites: Java 25, Node 20+, a Fabric client on **26.1.2**, and a launcher instance
you can add mods to. (26.2 and 1.21.x need their own port — see
[version support](#version-support).)

```sh
# 1. the CLI and MCP server
cd server && npm install && npm run build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/mcmcp     # or: npm link

# 2. the mod jar
cd ../mod && ./gradlew build                      # mod/build/libs/mcmcp-<version>.jar

# 3. put the mod in your instances
mcmcp install --all                                # every Fabric instance it can find
mcmcp install --instance "Fabulously Optimized(1)"

# 4. tell OpenCode about it, once, globally
mcmcp setup-opencode --global
```

Restart OpenCode, then ask it to call `mc_status`. If nothing is running yet:

```sh
mcmcp launch "Fabulously Optimized(1)"   # starts Prism, waits for the mod to answer
```

`mcmcp doctor` checks all of it — token, endpoint, instances, jar, PATH, OpenCode config.
`mcmcp launch` finds Prism on PATH, as a Flatpak, or as an AppImage under `~/Applications`,
`~/AppImages` or `~/Downloads`; point `MCMCP_PRISM` at the executable if yours lives
elsewhere.

### Per project

The MCP server is global, so every OpenCode project already gets the tools. To pin an
entry in a specific repo instead (checked in, shared with teammates):

```sh
cd ~/some/project && mcmcp setup-opencode --project .
```

Both forms write the same server entry; the project form writes `./opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "minecraft": { "type": "local", "command": ["mcmcp", "serve"], "enabled": true }
    }
  }
}
```

## Version support

The mod compiles and runs against **26.1.2**; the jar declares `minecraft: ~26.1`, and
`mcmcp install --all` skips instances whose version does not match instead of breaking
them. Ports:

- **26.2** — screen state moved from `Minecraft.screen/setScreen` to `Gui.screen()/setScreen()`,
  `Gui#getChat` and `Minecraft#getMainRenderTarget` were removed, and Fabric's
  `FabricClientCommandSource` gained `attended()`. That is a compat layer, not a flag.
- **1.21.11 and earlier** — obfuscated, so the build needs `fabric-loom-remap` and Yarn
  mappings, and several names used here (`Identifier` vs `ResourceLocation`, key/mouse
  event records, `getOverworldClockTime`, `GameProfile#name`) do not exist.

`docs/ARCHITECTURE.md#version-support` has the details and the build command for a
matrix entry.

## CLI

```
mcmcp status                       # what the client is doing
mcmcp call gui.screen              # any method, raw JSON in/out
mcmcp call player.moveTo '{"x":100,"y":64,"z":200}'
mcmcp methods                      # the mod's own method catalog
mcmcp instances                    # Prism/native/.minecraft instances and mod status
mcmcp install|uninstall|launch|logs
mcmcp config show|path|init
mcmcp doctor
mcmcp serve                        # MCP over stdio (what OpenCode runs)
```

`--json` on any command prints raw JSON. Every MCP tool maps 1:1 onto a CLI call, so
anything an agent does you can reproduce by hand.

Environment overrides:

| variable | meaning |
| --- | --- |
| `MCMCP_URL` | full base URL, e.g. `http://127.0.0.1:25585` |
| `MCMCP_HOST` / `MCMCP_PORT` | endpoint when no client descriptor is found |
| `MCMCP_TOKEN` | bearer token, overrides `~/.config/mcmcp/token` |
| `MCMCP_MOD_JAR` | jar to install when `--jar` is omitted |
| `MCMCP_PRISM` | PrismLauncher executable (AppImage included) |
| `MCMCP_PRISM_DIRS` | where to look for the AppImage (path list; empty disables the search) |

## MCP tools

| tool | does |
| --- | --- |
| `mc_status` | client/version/player/screen/FPS/ping snapshot |
| `mc_screen` | inspect widgets, click by label or id, type into fields, send keys, open/close screens, wait for a screen |
| `mc_input` | raw keys, mouse buttons, camera deltas, scrolling, typing |
| `mc_options` | list/get/set all 100+ client options and every key bind (including modded) |
| `mc_chat` | send chat, read history, clear |
| `mc_command` | client commands (`/nonick`, `/mcmcp`) or server commands |
| `mc_player` | state, look, walk, moveTo, jump, sneak, sprint, attack, use, hotbar, inventory, drop, respawn |
| `mc_world` | time/weather/biome, block lookups, block scans, entities, tab list, raycast, open container |
| `mc_events` | long-poll chat / screen / join / death events |
| `mc_client` | connect, disconnect, quit, screenshot, window info |
| `mc_raw` | any method by name, with the catalog in the error when you guess wrong |
| `mc_instances` | discovered instances, loader, mod presence |
| `mc_mod` | install/uninstall/status of the mod jar |
| `mc_launch` | start a Prism instance and wait for it to answer |
| `mc_logs` | tail `logs/latest.log` |

## Examples

```sh
# read and change settings, then verify
mcmcp call client.options.get '{"key":"renderDistance"}'
mcmcp call client.options.set '{"key":"renderDistance","value":8}'
mcmcp call client.options.set '{"key":"fov","value":90}'

# rebind and press
mcmcp call client.keybind.set '{"action":"key.sprint","key":"R"}'
mcmcp call client.keybind.press '{"action":"key.jump"}'

# drive a menu by its visible labels
mcmcp call gui.click '{"label":"Options..."}'
mcmcp call gui.click '{"label":"Music & Sounds..."}'
mcmcp call gui.close

# talk, command, observe
mcmcp call chat.send '{"message":"hi"}'
mcmcp call command.run '{"command":"time set night"}'
mcmcp call events.poll '{"timeoutMs":3000,"types":["chat"]}'

# move and capture
mcmcp call player.moveTo '{"x":80,"y":64,"z":120,"timeoutMs":10000}'
mcmcp call client.screenshot '{"name":"base"}'
```

## Safety

- The control server binds `127.0.0.1` only and requires the token in
  `~/.config/mcmcp/token` (mode 0600, created on first run by either side).
- Nothing is exposed to the network unless you set `"allowRemote": true` in
  `config/mcmcp.json` **and** forward the port deliberately.
- The agent has the same powers as your keyboard. It can quit the game, join servers and
  run commands your account is allowed to run. Keep the token private.
- `mcmcp` never sends your session credentials anywhere; it only speaks to the client on
  loopback.

## Development

```sh
cd server && npm test              # 63 unit tests, no game needed
node scripts/smoke.mjs             # MCP over stdio against a live client
cd ../mod && ./gradlew build       # 26.1.2 jar
./gradlew build -Pminecraft_version=26.2 -Pfabric_api_version=0.161.0+26.2 \
                -Pminecraft_dependency='~26.2'   # matrix entry
mcmcp doctor                       # everything at once
```

The mod's method catalog is generated from the registrations, so `mcmcp methods` and
`GET /methods` always match the code. Handlers run on the client thread; anything that
waits returns a future driven by `Events.tickFor`, so the game keeps rendering.

## Layout

```
mod/      Fabric client mod (Java 25, Minecraft 26.x)
  src/main/java/dev/mcmcp/     control server, method groups, input bridge
  src/main/resources/          fabric.mod.json, mixins
server/   TypeScript MCP server + CLI
  src/tools.ts                 the 15 MCP tools
  src/cli.ts                   the mcmcp CLI
  src/protocol.ts              HTTP/JSON-RPC client
  src/instances.ts             launcher discovery, mod install
  src/opencode.ts              OpenCode config wiring
docs/     protocol and architecture
```

## License

MIT

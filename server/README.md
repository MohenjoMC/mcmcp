# mcmcp bridge (MCP server + CLI)

TypeScript bridge that talks to the **mcmcp** Fabric mod running inside a live
Minecraft Java client. It exposes MCP tools (for OpenCode and other MCP clients) and
a `mcmcp` CLI that can do everything the tools can.

The wire contract lives in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md); this package
implements it (`src/protocol.ts`) and adds discovery, instances, launcher, OpenCode
wiring and a doctor.

## Requirements

- Node.js >= 20 (developed on 26)
- Minecraft Java with a **Fabric** instance and the `mcmcp` mod jar in its `mods/`
- PrismLauncher (native or Flatpak) if you want `mcmcp launch` to start the game

## Install

```bash
cd server
npm install          # also builds via "prepare"
npm run build        # tsc -> dist/
npm test             # builds, then node --test dist/**/*.test.js
```

Put the CLI on `PATH` (pick one):

```bash
npm link                                   # global link, needs a writable npm prefix
# or, without root:
ln -sf "$PWD/dist/cli.js" ~/.local/bin/mcmcp && chmod +x dist/cli.js
```

Both `node dist/cli.js …` and `mcmcp …` behave identically.

## Quick start

```bash
# after building the mod: mod/build/libs/mcmcp-1.0.0+26.1.2.jar
mcmcp instances                       # find the Fabric instance id
mcmcp install --instance Performium   # or --all
mcmcp launch Performium               # starts Prism and waits for the mod
mcmcp status                          # what the game is doing right now
mcmcp call gui.screen                 # any method from the catalog
```

## Commands

| command | what it does |
| --- | --- |
| `mcmcp serve` | MCP server on stdio. Nothing but protocol frames goes to stdout. |
| `mcmcp status` | `status` from the mod: versions, player, screen, FPS, ping. |
| `mcmcp health` | Cheap `/health` probe, no JSON-RPC. |
| `mcmcp call <method> [json\|@file]` | Call any mod method, e.g. `mcmcp call player.moveTo '{"x":0,"y":64,"z":0}'`. |
| `mcmcp methods` | The mod's method catalog (`GET /methods`). |
| `mcmcp tools` | The MCP tools this package exposes. |
| `mcmcp instances` | Prism (native + Flatpak) and `~/.minecraft` instances, loader, mod state. |
| `mcmcp install [--instance <id>\|--all] [--jar <path>]` | Copy the newest built jar into `mods/`, replacing older mcmcp jars. |
| `mcmcp uninstall --instance <id>\|--all` | Remove mcmcp jars. |
| `mcmcp launch <instance> [--no-wait] [--timeoutMs <n>]` | Spawn Prism detached and wait for a fresh client (default 180 s). |
| `mcmcp logs [--instance <id>] [--lines N]` | Tail `<gameDir>/logs/latest.log`. |
| `mcmcp config [show\|path\|init]` | Show/create the config and token. |
| `mcmcp doctor` | PASS/WARN/FAIL for node, config, token, clients, instances, jar, PATH, OpenCode, port. |
| `mcmcp setup-opencode [--global\|--project <dir>] [--v1]` | Merge the `minecraft` MCP server into an OpenCode config. |
| `mcmcp completion <bash\|zsh>` | Shell completion. |

Global flag: `--json` prints raw JSON instead of the human summary. Exit codes: `0` ok,
`1` error (`mcmcp: <message>` on stderr).

## MCP / OpenCode

```bash
mcmcp setup-opencode --global              # ~/.config/opencode/opencode.json(c)
mcmcp setup-opencode --project .           # ./opencode.json
mcmcp setup-opencode --global --v1         # force the pre-2.0 schema
```

v2 (OpenCode 2.x) writes:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "minecraft": { "type": "local", "command": ["mcmcp", "serve"], "enabled": true } } }
}
```

v1 writes the same entry under `"mcp": { "minecraft": … }`. The command detects the
existing shape, strips JSONC comments/trailing commas before merging, keeps other keys
and servers, backs the file up to `<file>.bak`, and is idempotent. If `mcmcp` is not on
`PATH` it still writes `"mcmcp"` but warns (and `doctor` reports it).

## Discovery, config, token

- Config dir: `$XDG_CONFIG_HOME/mcmcp` or `~/.config/mcmcp`.
- `config.json`: `{"host":"127.0.0.1","port":25585,"tokenFile":"…/token","allowRemote":false}`.
- `token`: 32 random bytes as hex, mode `0600`, created on first use, never overwritten.
- `clients/<pid>.json`: descriptors written by the mod. The bridge drops (and deletes)
  entries whose pid is gone and probes the rest; the newest healthy client wins.
- Address precedence: `MCMCP_URL`, then `MCMCP_PORT` + `MCMCP_HOST`, then explicit
  options, then descriptors.
- Token precedence: explicit option, `MCMCP_TOKEN`, config `tokenFile`, the default
  token path.

Environment:

| variable | meaning |
| --- | --- |
| `MCMCP_URL` | Full base URL, e.g. `http://127.0.0.1:25585`. |
| `MCMCP_HOST` / `MCMCP_PORT` | Address when you don't want discovery. |
| `MCMCP_TOKEN` | Bearer token override. |
| `MCMCP_MOD_JAR` | Jar used by `install` when `--jar` is omitted. |

## MCP tools

`mc_status`, `mc_screen`, `mc_input`, `mc_options`, `mc_chat`, `mc_command`,
`mc_player`, `mc_world`, `mc_events`, `mc_client`, `mc_raw`, `mc_instances`, `mc_mod`,
`mc_launch`, `mc_logs`.

Each returns readable text plus `structuredContent`; mod errors come back as
`isError` with the JSON-RPC code (`-32602` bad params, `-32000` bad state, `-32001`
timeout, `-32002` bad token, `-32003` unsupported). Stack traces are only surfaced when
the mod itself puts one in `data.trace`.

## Layout

```
src/protocol.ts    ModClient + wire types (given)
src/config.ts      config, token, descriptors, resolveClient
src/instances.ts   Prism/vanilla discovery, install/uninstall, logs
src/launcher.ts    detached Prism/Flatpak launch + health wait
src/tools.ts       the 15 MCP tools
src/mcp.ts         McpServer factory (createServer) + stdio
src/cli.ts         the mcmcp CLI
src/opencode.ts    OpenCode config merge
src/doctor.ts      the doctor report
src/index.ts       public API
src/testutil.ts    fake mod HTTP server for tests
```

## Troubleshooting

- **`no Minecraft client found`** — the game isn't running, the mod isn't installed, or the
  control server was shut down. `mcmcp instances`, `mcmcp install --instance <id>`,
  `mcmcp launch <id>`.
- **`the client rejected the token` (-32002)** — the bridge and mod disagree on
  `tokenFile`; check `mcmcp config show` and `~/.config/mcmcp/token`.
- **`mcmcp doctor` shows the port used by something else** — harmless: the mod picks the
  next free port and writes it in its descriptor.
- **Non-Fabric instance** — mcmcp is a Fabric mod; Prism → Edit → Version → Fabric.

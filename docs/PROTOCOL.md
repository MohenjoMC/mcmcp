# mcmcp wire protocol (v1)

Two processes talk over this protocol:

- **the mod** (`mcmcp` Fabric client mod) runs an HTTP server on the loopback interface
  inside the Minecraft client;
- **the bridge** (`mcmcp serve`, TypeScript) exposes MCP tools and calls the mod;
- **the CLI** (`mcmcp call …`) talks to the same endpoint, so anything the MCP server
  can do can be done from a shell.

Everything is JSON. There is no SDK or code generation: the mod is the single source of
truth for the method catalog, and `GET /methods` returns it.

## Discovery

The mod listens on `127.0.0.1` (default port `25585`, first free port if taken) and writes
a runtime descriptor per client process:

```
~/.config/mcmcp/clients/<pid>.json
{"pid":5123,"port":25585,"mcVersion":"26.1.2","modVersion":"1.0.0","player":"Steve","startedAt":1770000000000}
```

The descriptor is removed on clean shutdown. A stale descriptor (process gone) is
ignored by the bridge.

Config file, read at startup by the mod and by the bridge:

```
~/.config/mcmcp/config.json
{"host":"127.0.0.1","port":25585,"tokenFile":"~/.config/mcmcp/token","allowRemote":false}
```

The token is a random 32-byte hex string in `tokenFile`. First process to start creates
it with mode `0600`. Unless `allowRemote` is true, the mod refuses non-loopback peers.

## Requests

```
POST /rpc
Authorization: Bearer <token>
Content-Type: application/json

{"jsonrpc":"2.0","id":7,"method":"player.state","params":{}}
```

Success:

```
{"jsonrpc":"2.0","id":7,"result":{ ... }}
```

Failure (HTTP 200; transport errors use 4xx/5xx with the same body shape):

```
{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"no player","data":{"method":"player.state"}}}
```

`id` may be a string, number or null. The mod never sends unsolicited JSON-RPC messages;
events are polled (below).

### Other endpoints

| endpoint | auth | meaning |
| --- | --- | --- |
| `GET /health` | no | liveness: `{"ok":true,"name":"mcmcp","version":"1.0.0","mc":"26.1.2","player":"Steve","inWorld":true,"uptimeMs":123}` |
| `GET /methods` | yes | the method catalog (see below) |
| `GET /events?after=<seq>&timeoutMs=<ms>` | yes | long-poll events; returns as soon as one is available or the timeout expires |
| `POST /shutdown` | yes | stop the control server (the game keeps running) |

`/methods` returns an array of:

```json
{
  "name": "gui.click",
  "summary": "Click a widget in the current screen.",
  "params": {
    "label": {"type": "string", "required": false, "description": "Match widget text, case-insensitive substring."},
    "id": {"type": "integer", "required": false, "description": "Widget index from gui.screen."},
    "x": {"type": "number", "required": false},
    "y": {"type": "number", "required": false},
    "button": {"type": "integer", "required": false, "default": 0}
  },
  "returns": "{\"clicked\":{...widget...}}"
}
```

## Threading and timing

Every mutating method runs on the client thread and completes before the response is
written. Methods that wait (`gui.waitFor`, `player.moveTo`, `events.poll`) block up to
their own timeout, capped at 30 s by the mod. The default HTTP timeout in the bridge is
35 s.

## Events

Each event is `{"seq":n,"time":<epochMs>,"type":"...","data":{...}}`. `seq` is monotonic
per client process and `GET /events` returns events with `seq > after`. Types:

| type | when | data |
| --- | --- | --- |
| `chat` | chat message or game message | `{"text":"...","kind":"chat"\|"system"\|"action"}` |
| `screen` | screen opened/closed | `{"screen":"...","title":"..."}` |
| `tick` | only when subscribed via `events.subscribe` | `{"tps":20,"tick":123}` |
| `log` | mod-internal notice | `{"level":"info","message":"..."}` |
| `join` / `leave` | world joined/left | `{"world":"...","dimension":"..."}` |
| `death` | player died | `{"message":"..."}` |

The event buffer is a ring of 2000 entries. `GET /events` without `after` returns the
most recent 50.

## Method catalog

Coordinate conventions: `x/y/z` are blocks (world space) unless the method says
otherwise; `yaw` is degrees clockwise from south, `pitch` degrees down-positive, exactly
as Minecraft reports them. GUI coordinates are **GUI-scaled pixels** (the same space as
`Screen#mouseClicked`), not raw window pixels.

### status

| method | params | returns |
| --- | --- | --- |
| `status` | – | `{"modVersion","mcVersion","loaderVersion","fabricApiVersion","player":{"name","uuid"},"inWorld","screen":{"id","title"},"fps","ping","uptimeMs"}` |

### client

| method | params | returns |
| --- | --- | --- |
| `client.options.list` | `{"group"?:"options"\|"keybinds"}` | `[{"key","value","type","group"}]`; `type` is `boolean`,`int`,`long`,`double`,`float`,`string`,`enum:<Name>`; 26.1.2 reports 105 options and 60 key binds |
| `client.options.get` | `{"key"}` | `{"key","value","type"}` |
| `client.options.set` | `{"key","value"}` | `{"key","value","previous"}`; persists via `options.txt` |
| `client.keybind.list` | – | `[{"action","key","category","defaultKey"}]`; `action` is the translation key, e.g. `key.jump` |
| `client.keybind.set` | `{"action","key"}` | `{"action","key"}`; `key` is a GLFW key name (`W`, `SPACE`, `LEFT_SHIFT`) or mouse name (`MOUSE_LEFT`) |
| `client.keybind.press` | `{"action","holdMs"?}` | `{"action","held":true}`; presses for `holdMs` (default 50 ms) then releases |
| `client.keybind.release` | `{"action"}` | `{"action","held":false}` |
| `client.screenshot` | `{"name"?}` | `{"path","width","height"}`; writes under `screenshots/` |
| `client.window` | – | `{"width","height","guiScale","fullscreen","focused"}` |
| `client.connect` | `{"address","port"?}` | `{"connecting":true,"address"}` |
| `client.disconnect` | – | `{"disconnected":true}` |
| `client.quit` | – | `{"quitting":true}` (reply is written first) |

### input

Low-level input is delivered to the client's normal input path, so it behaves like a
real keyboard/mouse: held keys keep the action down until released, and `input.key` with
`action:"press"` is a down+up pair.

| method | params | returns |
| --- | --- | --- |
| `input.key` | `{"key","action"?:"press"\|"down"\|"up","holdMs"?,"mods"?}` | `{"key","held"}` |
| `input.mouse` | `{"button"?:"left"\|"right"\|"middle"\|0..7,"action"?:"click"\|"down"\|"up","x"?,"y"?}` | `{"button","held"}` |
| `input.move` | `{"dx","dy"}` | `{"yaw","pitch"}` |
| `input.scroll` | `{"dy","x"?,"y"?}` | `{}` |
| `input.text` | `{"text"}` | `{"typed":n}` |
| `input.releaseAll` | – | `{"released":n}` |

### gui

| method | params | returns |
| --- | --- | --- |
| `gui.screen` | – | `{"id","title","widgets":[{"id","type","label","x","y","width","height","active","visible","value"?}],"lists":[{"id","class","entries":[{"index","x","y","width","height","labels","selected"}]}]}`; widget `id` is the index used by `gui.click` |
| `gui.click` | `{"label"?,"id"?,"list"?,"entry"?,"doubleClick"?,"x"?,"y"?,"button"?}` | `{"clicked":{"id","label"|"list","entry","x","y"},"screen":{...}}`; `label` matching prefers exact over substring and actionable widgets over plain text |
| `gui.type` | `{"text","field"?:"label or id","clear"?}` | `{"field":{...},"value":"..."}` |
| `gui.key` | `{"key","action"?:"press"}` | `{}` (delivered to the open screen, e.g. `ESCAPE`, `ENTER`, `TAB`) |
| `gui.open` | `{"screen":"inventory"\|"chat"\|"pause"\|"options"\|"social"\|"advancements"}` | `{"screen":"..."}` |
| `gui.close` | – | `{"screen":null}` |
| `gui.waitFor` | `{"label"?,"screen"?,"timeoutMs"?}` | `{"matched":true,"screen":{...}}`; errors with `gui.timeout` |

### chat and commands

| method | params | returns |
| --- | --- | --- |
| `chat.send` | `{"message"}` | `{"sent":true,"message"}` |
| `chat.history` | `{"limit"?}` | `{"messages":[{"text","kind","time"}]}` |
| `chat.clear` | – | `{"cleared":n}` |
| `command.run` | `{"command","clientOnly"?}` | `{"command","dispatched":"client"\|"server"}` |
| `command.client` | `{"command"}` | `{"command","dispatched":"client"}`; uses the client command dispatcher, so mod commands like `/nonick status` work |

`command.run` strips a leading `/`. A command is executed on the client when a matching
client command exists or `clientOnly` is true; otherwise it is sent to the server.

### player

| method | params | returns |
| --- | --- | --- |
| `player.state` | – | `{"name","uuid","position":{"x","y","z"},"velocity":{...},"yaw","pitch","onGround","health","maxHealth","food","saturation","air","xp":{"level","progress","total"},"gameMode","dimension","selectedSlot","sneaking","sprinting","flying","walking","ping","effects":[{"id","name","amplifier","duration"}]}` |
| `player.look` | `{"yaw"?,"pitch"?,"at"?:"x,y,z"\|{"x","y","z"},"entityId"?}` | `{"yaw","pitch"}` |
| `player.walk` | `{"direction":"forward"\|"back"\|"left"\|"right","ms"?,"sprint"?,"sneak"?}` | `{"moved":true,"position":{...}}` |
| `player.moveTo` | `{"x","y","z","tolerance"?,"timeoutMs"?,"sprint"?}` | `{"arrived":bool,"position":{...},"distance":n}`; straight-line walking with auto-jump, no pathfinding |
| `player.jump` | `{"holdMs"?}` | `{}` |
| `player.sneak` | `{"state"}` | `{"sneaking":bool}` |
| `player.sprint` | `{"state"}` | `{"sprinting":bool}` |
| `player.attack` | `{"entityId"?,"holdMs"?}` | `{"attacked":bool,"entityId"?}` |
| `player.use` | `{"hand"?:"main"\|"off","holdMs"?}` | `{"used":true}` |
| `player.select` | `{"slot":0..8,"name"?}` | `{"selectedSlot","item"}` |
| `player.drop` | `{"all"?}` | `{"dropped":true}` |
| `player.inventory` | – | `{"selectedSlot","hotbar":[…],"main":[…],"armor":[…],"offhand":…}` where each item is `{"slot","id","name","count","damage","maxDamage"}` |
| `player.respawn` | – | `{"respawned":true}` |

### world

| method | params | returns |
| --- | --- | --- |
| `world.state` | – | `{"dimension","time","dayTime","day":bool,"rain","thunder","difficulty","biome","scoreboardObjectives"?}` |
| `world.block` | `{"x","y","z"}` | `{"x","y","z","id","properties","hardness","light","skyLight","loaded":bool}` |
| `world.blocks` | `{"from":{"x","y","z"},"to":{"x","y","z"}}` | `{"blocks":[{"x","y","z","id"}],"truncated":bool}`; capped at 32768 positions |
| `world.entities` | `{"radius"?,"type"?}` | `[{"id","type","name","position","distance","health"?,"player":bool}]` |
| `world.players` | – | `[{"name","uuid","ping","gameMode"?,"team"?}]` from the tab list |
| `world.raycast` | `{"distance"?,"entities"?}` | `{"block":{...},"entity":{...}}` |
| `world.container` | – | `{"title","size","items":[…]}` for the open container screen, `null` otherwise |

### events

| method | params | returns |
| --- | --- | --- |
| `events.poll` | `{"after"?,"timeoutMs"?, "types"?}` | `{"events":[…],"next":n}` |
| `events.subscribe` | `{"tick":bool}` | `{"tick":bool}` |

### mod

| method | params | returns |
| --- | --- | --- |
| `mod.methods` | – | same catalog as `GET /methods` |
| `mod.ping` | – | `{"pong":true,"time":…}` |
| `mod.log` | `{"level"?,"message"}` | `{"logged":true}` |

## Error codes

| code | meaning |
| --- | --- |
| `-32700` | malformed JSON |
| `-32601` | unknown method |
| `-32602` | invalid params (message names the parameter) |
| `-32000` | state error (no player, no world, no screen, wrong screen) |
| `-32001` | timeout (`gui.timeout`, `player.timeout`) |
| `-32002` | denied (auth, non-loopback peer) |
| `-32003` | feature unavailable on this MC version |
| `-32100` | mod-internal error (stack trace in `data.trace`) |

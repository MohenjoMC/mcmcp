/**
 * MCP server factory: builds the `minecraft` server, registers the tool
 * surface and (for `mcmcp serve`) connects it to stdio.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'minecraft';

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', 'package.json'), // dist/mcp.js → server/package.json
      path.join(here, '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (raw.name === 'mcmcp' && typeof raw.version === 'string') return raw.version;
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    /* ignore */
  }
  return '1.0.0';
}

export const VERSION = readVersion();

export const INSTRUCTIONS = `mcmcp controls a live Minecraft Java client through the mcmcp Fabric mod.

Workflow:
1. Call mc_status first. It confirms the client is reachable, reports the endpoint, MC/mod versions, whether a
   world is loaded and which player is in it. If it fails with "no Minecraft client found", use mc_instances to
   find an instance, mc_mod to install the mod, then mc_launch, or ask the human to start the game.
2. Before touching a menu, call mc_screen with action:"inspect" to list the widgets. Click by label
   (case-insensitive substring) whenever possible; ids are only valid for the current screen and change when it
   does. All GUI coordinates are GUI-scaled pixels, the same space the game itself uses - not raw window pixels.
3. Option and keybind names must come from mc_options action:"list" / action:"keybind_list". Do not guess them.
4. Most gameplay actions need a loaded world and a player: check mc_status.inWorld or mc_player action:"state"
   first. Moves use straight-line walking with auto-jump, not pathfinding.
5. After an action that opens a screen or moves the player, confirm with mc_screen/mc_player instead of
   assuming it happened. Use mc_events to wait for chat or screen changes rather than polling in a tight loop.
6. Everything the tools do is also available from a shell: "mcmcp call <method> '<json params>'".

Errors carry the mod's JSON-RPC code: -32602 invalid params, -32000 bad state (no player/world/screen),
-32001 timeout, -32002 denied (token), -32003 unsupported on this MC version, -32100 mod-internal.`;

/** Build a fully registered MCP server (not yet connected to a transport). */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}

/** Connect a fresh server to stdio. Never writes anything but protocol frames. */
export async function serveStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until stdin closes; the transport handles SIGINT.
}

export { McpServer };

/**
 * MCP tool surface. Every tool maps onto one or more mod JSON-RPC methods from
 * docs/PROTOCOL.md, validates its own arguments with zod, and returns both
 * readable text and `structuredContent`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveClient, type ResolvedClient } from './config.js';
import {
  findBuiltJar,
  findInstance,
  installMod,
  listInstances,
  readInstanceLog,
  uninstallMod,
  type Instance,
} from './instances.js';
import { launchInstance } from './launcher.js';
import { McmcpError, ModClient, type MethodSpec } from './protocol.js';
import { clip, jsonPreview } from './util.js';

/* ------------------------------------------------------------------ */
/* Result plumbing                                                     */
/* ------------------------------------------------------------------ */

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  /** Called with the validated arguments; resolves to the structured payload. */
  handler: (args: ToolArgs) => Promise<unknown>;
  /** Optional custom text rendering (defaults to pretty JSON). */
  format?: (value: unknown, args: ToolArgs) => string;
}

const MOD_BITS: Record<string, number> = { shift: 1, control: 2, ctrl: 2, alt: 4, super: 8, meta: 8, cmd: 8 };

/** ["SHIFT","ALT"] -> GLFW modifier bitmask (1|4). */
function modsMask(mods: unknown): number | undefined {
  if (!Array.isArray(mods) || mods.length === 0) return undefined;
  let mask = 0;
  for (const mod of mods) {
    const bit = MOD_BITS[String(mod).toLowerCase()];
    if (!bit) throw new McmcpError(-32602, `unknown modifier "${String(mod)}" (expected SHIFT, CONTROL, ALT or SUPER)`);
    mask |= bit;
  }
  return mask;
}

const MAX_TEXT = 20_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(err: unknown): CallToolResult {
  if (err instanceof McmcpError) {
    const trace =
      isPlainObject(err.data) && typeof err.data.trace === 'string' ? `\n${clip(err.data.trace, 4000)}` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `${err.message} (code ${err.code})${trace}` }],
      structuredContent: { error: { code: err.code, message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `mcmcp internal error: ${message}` }],
    structuredContent: { error: { code: -32100, message } },
  };
}

function success(def: ToolDef, args: ToolArgs, value: unknown): CallToolResult {
  const preview = jsonPreview(value, MAX_TEXT);
  const text = clip(def.format ? def.format(value, args) : preview.text, MAX_TEXT);
  const structuredContent = preview.truncated
    ? { truncated: true, fullLength: preview.length, preview: preview.text }
    : isPlainObject(value)
      ? value
      : { result: value };
  return { content: [{ type: 'text', text }], structuredContent };
}

async function execute(def: ToolDef, args: ToolArgs): Promise<CallToolResult> {
  try {
    return success(def, args, await def.handler(args));
  } catch (err) {
    return failure(err);
  }
}

/* ------------------------------------------------------------------ */
/* Argument helpers                                                    */
/* ------------------------------------------------------------------ */

function str(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function vec(args: ToolArgs, key: string): { x: number; y: number; z: number } | undefined {
  const value = args[key];
  if (!isPlainObject(value)) return undefined;
  const x = value.x;
  const y = value.y;
  const z = value.z;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined;
  return { x, y, z };
}

/** Drop undefined values so the mod never sees `{"label":null}`-style noise. */
function params(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Client session (short cache so one tool call = one discovery)       */
/* ------------------------------------------------------------------ */

const CLIENT_TTL_MS = 1500;

let clientCache: { at: number; value: ResolvedClient } | null = null;
let methodsCache: { at: number; address: string; list: MethodSpec[] } | null = null;

/** Forget the cached client (used by tests and after connect/disconnect). */
export function resetClientCache(): void {
  clientCache = null;
  methodsCache = null;
}

export async function getClient(force = false): Promise<ResolvedClient> {
  if (!force && clientCache && Date.now() - clientCache.at < CLIENT_TTL_MS) return clientCache.value;
  const value = await resolveClient();
  clientCache = { at: Date.now(), value };
  return value;
}

async function catalog(client: ModClient): Promise<MethodSpec[]> {
  if (methodsCache && methodsCache.address === client.address && Date.now() - methodsCache.at < 60_000) {
    return methodsCache.list;
  }
  const list = await client.methods();
  methodsCache = { at: Date.now(), address: client.address, list };
  return list;
}

async function call(method: string, input: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const { client } = await getClient();
  return client.call(method, params(input), opts);
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function formatInstanceRow(instance: Instance): string {
  const loader = instance.loaderVersion ? `${instance.loader} ${instance.loaderVersion}` : instance.loader;
  const mod = instance.hasMod ? `mcmcp${instance.modVersion ? ` ${instance.modVersion}` : ''}` : 'not installed';
  return [
    instance.id.padEnd(24),
    (instance.mcVersion ?? '?').padEnd(10),
    loader.padEnd(22),
    mod.padEnd(18),
    instance.launcher,
    instance.name,
  ].join(' ');
}

function formatInstances(instances: Instance[]): string {
  if (instances.length === 0) return 'No Minecraft instances found.';
  const header = ['id'.padEnd(24), 'MC'.padEnd(10), 'loader'.padEnd(22), 'mod'.padEnd(18), 'launcher', 'name'].join(' ');
  return [header, ...instances.map(formatInstanceRow)].join('\n');
}

/* ------------------------------------------------------------------ */
/* Shared schema fragments                                             */
/* ------------------------------------------------------------------ */

const mcVersionNote =
  'Coordinates are GUI-scaled pixels (the same space as Minecraft\'s own screen coordinates), not raw window pixels.';

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'mc_status',
    title: 'Minecraft status',
    description:
      'Status of the running Minecraft client: mod/MC/loader versions, whether a world is loaded, the current ' +
      'player, the open screen, FPS, ping and uptime. Also reports the endpoint the bridge is talking to. ' +
      'Call this first to confirm the game is up and the mod is installed.',
    schema: {},
    handler: async () => {
      const { client, info } = await getClient(true);
      const status = await client.call<unknown>('status');
      return { endpoint: client.address, health: info, status };
    },
    format: (value) => {
      const v = isPlainObject(value) ? value : {};
      const status = isPlainObject(v.status) ? v.status : {};
      const player = isPlainObject(status.player) && typeof status.player.name === 'string' ? status.player.name : null;
      const screen = isPlainObject(status.screen) && typeof status.screen.title === 'string' ? status.screen.title : 'none';
      const lines = [
        `endpoint     ${String(v.endpoint ?? '?')}`,
        `minecraft    ${String(status.mcVersion ?? '?')} (${String(status.loaderVersion ?? '?')}, Fabric API ${String(status.fabricApiVersion ?? '?')})`,
        `mod          ${String(status.modVersion ?? '?')}`,
        `player       ${player ?? 'not in world'}${status.inWorld === false ? ' (menu)' : ''}`,
        `screen       ${screen}`,
        `fps          ${String(status.fps ?? '?')}   ping ${String(status.ping ?? '?')} ms`,
        `uptime       ${String(status.uptimeMs ?? '?')} ms`,
      ];
      return lines.join('\n');
    },
  },

  {
    name: 'mc_screen',
    title: 'Screens and widgets',
    description:
      'Inspect and drive the current GUI screen.\n' +
      `- action:"inspect" lists every widget with its id, type, label, position and size. ${mcVersionNote}\n` +
      '- action:"click" clicks a widget by label (case-insensitive substring match) or by id (from inspect), ' +
      'or at raw x/y coordinates.\n' +
      '- action:"type" types into a text field, optionally clearing it first.\n' +
      '- action:"key" sends a key (ESCAPE, ENTER, TAB, …) to the open screen; action:"open" opens a known ' +
      'screen (inventory, chat, pause, options, social, advancements, stats, recipe_book); action:"back" ' +
      'closes the current screen.\n' +
      '- action:"wait" blocks until a screen or a widget label appears (errors with code -32001 on timeout).\n' +
      'Always inspect before clicking: ids are only valid for the current screen.',
    schema: {
      action: z
        .enum(['inspect', 'click', 'type', 'key', 'open', 'back', 'wait'])
        .describe('What to do with the current screen.'),
      label: z
        .string()
        .optional()
        .describe('Widget text to match, case-insensitive substring (click/wait). Prefer this over x/y.'),
      id: z.number().int().optional().describe('Widget index from action:"inspect" (click).'),
      x: z.number().optional().describe('GUI-scaled X coordinate (click when no label/id is given).'),
      y: z.number().optional().describe('GUI-scaled Y coordinate (click when no label/id is given).'),
      button: z.number().int().min(0).max(7).optional().describe('Mouse button for click: 0 left (default), 1 right.'),
      list: z
        .number()
        .int()
        .optional()
        .describe('Selection list id from action:"inspect" (the lists array), for clicking a row.'),
      entry: z.number().int().optional().describe('Row index inside that list (click a row, e.g. a world or server).'),
      doubleClick: z
        .boolean()
        .optional()
        .describe('Send a double click, e.g. to play a selected world or open a resource pack.'),
      text: z.string().optional().describe('Text to type (type).'),
      field: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('Target text field for type: its label substring or widget id. Defaults to the first text field.'),
      clear: z.boolean().optional().describe('Replace the field contents (type). Default true.'),
      key: z.string().optional().describe('Key name for action:"key", e.g. ESCAPE, ENTER, TAB, E, or a single character.'),
      screen: z
        .string()
        .optional()
        .describe(
          'For action:"open": inventory|chat|pause|options|social|advancements. ' +
            'For action:"wait": a screen title substring to wait for.',
        ),
      timeoutMs: z.number().int().min(1).max(30_000).optional().describe('Timeout for action:"wait" (default 5000 ms, max 30000).'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'inspect':
          return call('gui.screen', {});
        case 'click':
          return call('gui.click', {
            label: str(args, 'label'),
            id: num(args, 'id'),
            x: num(args, 'x'),
            y: num(args, 'y'),
            button: num(args, 'button'),
            list: num(args, 'list'),
            entry: num(args, 'entry'),
            doubleClick: bool(args, 'doubleClick'),
          });
        case 'type':
          return call('gui.type', {
            text: str(args, 'text') ?? '',
            field: args.field,
            clear: bool(args, 'clear'),
          });
        case 'key':
          return call('gui.key', { key: str(args, 'key'), action: 'press' });
        case 'open':
          return call('gui.open', { screen: str(args, 'screen') });
        case 'back':
          return call('gui.close', {});
        case 'wait':
          return call(
            'gui.waitFor',
            { label: str(args, 'label'), screen: str(args, 'screen'), timeoutMs: num(args, 'timeoutMs') },
            { timeoutMs: (num(args, 'timeoutMs') ?? 5000) + 5000 },
          );
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}" (expected inspect|click|type|key|open|back|wait)`);
      }
    },
    format: (value, args) => {
      if (str(args, 'action') !== 'inspect' || !isPlainObject(value)) return JSON.stringify(value, null, 2);
      if (value.id === null || value.id === undefined) return 'no screen is open';
      const widgets = Array.isArray(value.widgets) ? value.widgets : [];
      const head = `screen "${String(value.title ?? '')}" (${String(value.id ?? '?')}): ${widgets.length} widget(s)`;
      const lists = Array.isArray(value.lists) ? value.lists : [];
      const rows = widgets.map((widget) => {
        const w = isPlainObject(widget) ? widget : {};
        const box = `[${String(w.x ?? '?')},${String(w.y ?? '?')} ${String(w.width ?? '?')}x${String(w.height ?? '?')}]`;
        const value = w.value !== undefined && w.value !== null ? ` = ${JSON.stringify(w.value)}` : '';
        const flags = w.active === false || w.visible === false ? ' (inactive)' : '';
        return `  #${String(w.id ?? '?')} ${String(w.type ?? '?').padEnd(14)} ${box.padEnd(24)} ${JSON.stringify(w.label ?? '')}${value}${flags}`;
      });
      const listRows = lists.flatMap((raw) => {
        const list = isPlainObject(raw) ? raw : {};
        const entries = Array.isArray(list.entries) ? list.entries : [];
        return entries.map((rawEntry) => {
          const entry = isPlainObject(rawEntry) ? rawEntry : {};
          const box = `[${String(entry.x ?? '?')},${String(entry.y ?? '?')} ${String(entry.width ?? '?')}x${String(entry.height ?? '?')}]`;
          const label = entry.narration ?? (Array.isArray(entry.labels) ? entry.labels.join(' | ') : '');
          const selected = entry.selected === true ? ' (selected)' : '';
          return `  list ${String(list.id ?? '?')} row ${String(entry.index ?? '?')} ${box} ${JSON.stringify(label)}${selected}`;
        });
      });
      return [head, ...rows, ...listRows].join('\n');
    },
  },

  {
    name: 'mc_input',
    title: 'Raw input',
    description:
      'Low-level keyboard/mouse input through the client\'s normal input path (as if a human pressed the key).\n' +
      '- action:"key" with action press (down+up), down (hold) or up (release); optional holdMs and mods ' +
      '(SHIFT, CONTROL, ALT).\n' +
      '- action:"mouse" clicks or holds a button at GUI-scaled x/y.\n' +
      '- action:"move" turns the camera by dx/dy (mouse delta, like moving the physical mouse).\n' +
      '- action:"scroll" scrolls the hotbar or a list; action:"text" types characters; action:"releaseAll" ' +
      'releases every held key/button.\n' +
      'Use mc_screen for ordinary clicking - this is for gameplay input that no screen consumes.',
    schema: {
      action: z.enum(['key', 'mouse', 'move', 'scroll', 'text', 'releaseAll']).describe('Input family.'),
      key: z.string().optional().describe('GLFW key name for action:"key" (W, SPACE, LEFT_SHIFT, F3, …).'),
      keyAction: z
        .enum(['press', 'down', 'up'])
        .optional()
        .describe('press = down+up (default), down = hold until released, up = release.'),
      mods: z.array(z.string()).optional().describe('Modifiers held during action:"key", e.g. ["SHIFT"] or ["CONTROL","ALT"].'),
      holdMs: z.number().int().min(1).max(30_000).optional().describe('How long to hold for action:"key"/"mouse" (default 50 ms).'),
      button: z
        .union([z.number().int().min(0).max(7), z.enum(['left', 'right', 'middle'])])
        .optional()
        .describe('Mouse button for action:"mouse" (default left).'),
      buttonAction: z.enum(['click', 'down', 'up']).optional().describe('click = down+up (default), down = hold, up = release.'),
      dx: z.number().optional().describe('Horizontal mouse delta in action:"move" (positive = right).'),
      dy: z.number().optional().describe('Vertical mouse delta in action:"move" (positive = down; pitch down-positive).'),
      x: z.number().optional().describe('GUI-scaled X target for action:"mouse" (defaults to screen centre).'),
      y: z.number().optional().describe('GUI-scaled Y target for action:"mouse" (defaults to screen centre).'),
      text: z.string().optional().describe('Characters to type for action:"text".'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'key':
          return call('input.key', {
            key: str(args, 'key'),
            action: str(args, 'keyAction'),
            holdMs: num(args, 'holdMs'),
            mods: modsMask(args.mods),
          });
        case 'mouse':
          return call('input.mouse', {
            button: args.button,
            action: str(args, 'buttonAction'),
            x: num(args, 'x'),
            y: num(args, 'y'),
          });
        case 'move':
          return call('input.move', { dx: num(args, 'dx') ?? 0, dy: num(args, 'dy') ?? 0 });
        case 'scroll':
          return call('input.scroll', { dy: num(args, 'dy') ?? 0, x: num(args, 'x'), y: num(args, 'y') });
        case 'text':
          return call('input.text', { text: str(args, 'text') ?? '' });
        case 'releaseAll':
          return call('input.releaseAll', {});
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}" (expected key|mouse|move|scroll|text|releaseAll)`);
      }
    },
  },

  {
    name: 'mc_options',
    title: 'Game options and keybinds',
    description:
      'Read and change Minecraft settings and key bindings.\n' +
      '- action:"list" returns every option (or only group:"options"/"keybinds") with key, value and type. ' +
      'Option keys come from here - do not guess them.\n' +
      '- action:"get"/"set" read or change one option (set persists to options.txt).\n' +
      '- action:"keybind_list" lists bindings with their action translation key (e.g. key.jump); ' +
      'keybind_set rebinds one (GLFW names like W, SPACE, LEFT_SHIFT or mouse names like MOUSE_LEFT); ' +
      'keybind_press/keybind_release trigger or hold an action.',
    schema: {
      action: z
        .enum(['list', 'get', 'set', 'keybind_list', 'keybind_set', 'keybind_press', 'keybind_release'])
        .describe('Operation to perform.'),
      key: z
        .string()
        .optional()
        .describe('Option key for get/set (from action:"list"), or the GLFW/mouse key name for action:"keybind_set".'),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe('New value for set; type must match the option type (booleans are true/false, enums a string).'),
      group: z.enum(['options', 'keybinds']).optional().describe('Filter for action:"list".'),
      keybind: z
        .string()
        .optional()
        .describe('Keybind action translation key for keybind_set/press/release, e.g. "key.jump" (from keybind_list).'),
      holdMs: z.number().int().min(1).max(30_000).optional().describe('Hold time for keybind_press (default 50 ms).'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'list':
          return call('client.options.list', { group: str(args, 'group') });
        case 'get':
          return call('client.options.get', { key: str(args, 'key') });
        case 'set':
          return call('client.options.set', { key: str(args, 'key'), value: args.value });
        case 'keybind_list':
          return call('client.keybind.list', {});
        case 'keybind_set':
          return call('client.keybind.set', { action: str(args, 'keybind'), key: str(args, 'key') });
        case 'keybind_press':
          return call('client.keybind.press', { action: str(args, 'keybind'), holdMs: num(args, 'holdMs') });
        case 'keybind_release':
          return call('client.keybind.release', { action: str(args, 'keybind') });
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}"`);
      }
    },
    format: (value, args) => {
      const action = str(args, 'action');
      if ((action === 'list' || action === 'keybind_list') && Array.isArray(value)) {
        return value
          .map((row) => {
            const r = isPlainObject(row) ? row : {};
            const name = r.key ?? r.action ?? '?';
            const extra = r.type ?? r.category ?? '';
            return `${String(name).padEnd(42)} ${JSON.stringify(r.value ?? r.key ?? '')}${extra ? `  (${String(extra)})` : ''}`;
          })
          .join('\n');
      }
      return JSON.stringify(value, null, 2);
    },
  },

  {
    name: 'mc_chat',
    title: 'Chat',
    description:
      'Send a chat message or read the recent chat. action:"send" posts `message` (no leading slash needed; ' +
      'use mc_command for commands), action:"history" returns the last `limit` messages, action:"clear" ' +
      'empties the visible chat log.',
    schema: {
      action: z.enum(['send', 'history', 'clear']).describe('Chat operation.'),
      message: z.string().optional().describe('Message text for action:"send".'),
      limit: z.number().int().min(1).max(500).optional().describe('How many messages to return for action:"history" (default 50).'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'send':
          return call('chat.send', { message: str(args, 'message') ?? '' });
        case 'history':
          return call('chat.history', { limit: num(args, 'limit') });
        case 'clear':
          return call('chat.clear', {});
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}" (expected send|history|clear)`);
      }
    },
    format: (value) => {
      if (isPlainObject(value) && Array.isArray(value.messages)) {
        return value.messages
          .map((m) => {
            const msg = isPlainObject(m) ? m : {};
            const kind = typeof msg.kind === 'string' ? msg.kind : 'chat';
            return `[${kind}] ${String(msg.text ?? '')}`;
          })
          .join('\n');
      }
      return JSON.stringify(value, null, 2);
    },
  },

  {
    name: 'mc_command',
    title: 'Run a command',
    description:
      'Run a Minecraft command (a leading "/" is optional). The mod executes it on the client when a matching ' +
      'client command exists or clientOnly is true, otherwise it is sent to the server. Error code -32000 ' +
      'means no world is loaded; -32003 means the command is unavailable on this MC version.',
    schema: {
      command: z.string().min(1).describe('Command text, with or without a leading "/", e.g. "time set day".'),
      clientOnly: z
        .boolean()
        .optional()
        .describe('Force client-side dispatch (mod commands such as /nonick status). Default false.'),
    },
    handler: async (args) => call('command.run', { command: str(args, 'command') ?? '', clientOnly: bool(args, 'clientOnly') }),
    format: (value) => {
      const v = isPlainObject(value) ? value : {};
      return `/${String(v.command ?? '')} → ${String(v.dispatched ?? 'dispatched')}`;
    },
  },

  {
    name: 'mc_player',
    title: 'Player actions',
    description:
      'Read and control the local player. action:"state" (position, health, hunger, xp, gamemode, effects), ' +
      'look (yaw/pitch degrees, yaw clockwise from south, pitch down-positive; or entityId), ' +
      'walk (direction forward|back|left|right for ms), moveTo (straight-line walk with auto-jump, no ' +
      'pathfinding), jump, sneak(state), sprint(state), attack(entityId or whatever is in front), ' +
      'use(hand), select(hotbar slot), drop(all), inventory, respawn.\n' +
      'pos is a {x,y,z} block position. Moves require a loaded world.',
    schema: {
      action: z
        .enum([
          'state',
          'look',
          'walk',
          'moveTo',
          'jump',
          'sneak',
          'sprint',
          'attack',
          'use',
          'select',
          'drop',
          'inventory',
          'respawn',
        ])
        .describe('Player operation.'),
      x: z.number().optional().describe('Target X (moveTo) or look-at X.'),
      y: z.number().optional().describe('Target Y (moveTo) or look-at Y.'),
      z: z.number().optional().describe('Target Z (moveTo) or look-at Z.'),
      yaw: z.number().optional().describe('Absolute yaw in degrees for action:"look" (clockwise from south).'),
      pitch: z.number().optional().describe('Absolute pitch in degrees for action:"look" (down-positive).'),
      entityId: z.number().int().optional().describe('Entity id (from mc_world entities) for look/attack.'),
      direction: z.enum(['forward', 'back', 'left', 'right']).optional().describe('Direction for action:"walk".'),
      ms: z.number().int().min(1).max(30_000).optional().describe('How long to walk in milliseconds (default 500).'),
      sprint: z.boolean().optional().describe('Sprint while walking/moving.'),
      sneak: z.boolean().optional().describe('Sneak while walking.'),
      state: z.boolean().optional().describe('Desired state for action:"sneak"/"sprint" (true = on).'),
      slot: z.number().int().min(0).max(8).optional().describe('Hotbar slot 0-8 for action:"select".'),
      name: z.string().optional().describe('Select by item name instead of slot (action:"select").'),
      tolerance: z.number().min(0).max(16).optional().describe('Arrival tolerance in blocks for moveTo (default 1).'),
      timeoutMs: z.number().int().min(1).max(30_000).optional().describe('Timeout for moveTo (default 10000, max 30000).'),
      holdMs: z.number().int().min(1).max(30_000).optional().describe('Hold time for jump/attack/use (default 50 ms).'),
      hand: z.enum(['main', 'off']).optional().describe('Hand for action:"use" (default main).'),
      all: z.boolean().optional().describe('Drop the whole stack (action:"drop").'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'state':
          return call('player.state', {});
        case 'look': {
          const hasTarget = ['x', 'y', 'z'].every((key) => num(args, key) !== undefined);
          return call('player.look', {
            yaw: num(args, 'yaw'),
            pitch: num(args, 'pitch'),
            at: hasTarget ? { x: num(args, 'x'), y: num(args, 'y'), z: num(args, 'z') } : undefined,
            entityId: num(args, 'entityId'),
          });
        }
        case 'walk':
          return call(
            'player.walk',
            { direction: str(args, 'direction'), ms: num(args, 'ms'), sprint: bool(args, 'sprint'), sneak: bool(args, 'sneak') },
            { timeoutMs: (num(args, 'ms') ?? 500) + 10_000 },
          );
        case 'moveTo':
          return call(
            'player.moveTo',
            {
              x: num(args, 'x'),
              y: num(args, 'y'),
              z: num(args, 'z'),
              tolerance: num(args, 'tolerance'),
              timeoutMs: num(args, 'timeoutMs'),
              sprint: bool(args, 'sprint'),
            },
            { timeoutMs: (num(args, 'timeoutMs') ?? 10_000) + 5000 },
          );
        case 'jump':
          return call('player.jump', { holdMs: num(args, 'holdMs') });
        case 'sneak':
          return call('player.sneak', { state: bool(args, 'state') ?? true });
        case 'sprint':
          return call('player.sprint', { state: bool(args, 'state') ?? true });
        case 'attack':
          return call('player.attack', { entityId: num(args, 'entityId'), holdMs: num(args, 'holdMs') });
        case 'use':
          return call('player.use', { hand: str(args, 'hand'), holdMs: num(args, 'holdMs') });
        case 'select':
          return call('player.select', { slot: num(args, 'slot'), name: str(args, 'name') });
        case 'drop':
          return call('player.drop', { all: bool(args, 'all') });
        case 'inventory':
          return call('player.inventory', {});
        case 'respawn':
          return call('player.respawn', {});
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}"`);
      }
    },
    format: (value, args) => {
      const action = str(args, 'action');
      if (action === 'inventory' && isPlainObject(value)) {
        const item = (raw: unknown): string => {
          const it = isPlainObject(raw) ? raw : {};
          if (!it.id) return '-';
          return `${String(it.name ?? it.id)} x${String(it.count ?? 1)}${it.damage ? ` (${String(it.damage)}/${String(it.maxDamage ?? '?')})` : ''}`;
        };
        const list = (raw: unknown): string => (Array.isArray(raw) ? raw.map(item).join(', ') : '-');
        return [
          `selected slot ${String(value.selectedSlot ?? '?')}`,
          `hotbar: ${list(value.hotbar)}`,
          `main:   ${list(value.main)}`,
          `armor:  ${list(value.armor)}`,
          `offhand: ${item(value.offhand)}`,
        ].join('\n');
      }
      if (action === 'state' && isPlainObject(value)) {
        const pos = isPlainObject(value.position) ? value.position : {};
        const fmt = (n: unknown): string => (typeof n === 'number' ? n.toFixed(1) : '?');
        return [
          `${String(value.name ?? '?')} @ ${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)} (${String(value.dimension ?? '?')})`,
          `health ${String(value.health ?? '?')}/${String(value.maxHealth ?? '?')}  food ${String(value.food ?? '?')}  xp ${String(isPlainObject(value.xp) ? value.xp.level : '?')}`,
          `yaw ${fmt(value.yaw)}  pitch ${fmt(value.pitch)}  slot ${String(value.selectedSlot ?? '?')}  ${String(value.gameMode ?? '?')}`,
          `onGround ${String(value.onGround)}  sprinting ${String(value.sprinting)}  sneaking ${String(value.sneaking)}  flying ${String(value.flying)}  ping ${String(value.ping)}`,
        ].join('\n');
      }
      return JSON.stringify(value, null, 2);
    },
  },

  {
    name: 'mc_world',
    title: 'World queries',
    description:
      'Read world state and inspect blocks/entities. action:"state" (dimension, time, weather, difficulty, ' +
      'biome), "block" (one position: id, properties, hardness, light), "blocks" (inclusive box from→to, capped ' +
      'at 32768 positions), "entities" (nearby entities with distance), "players" (tab list), "raycast" ' +
      '(what the player is looking at), "container" (items in the open container screen).',
    schema: {
      action: z.enum(['state', 'block', 'blocks', 'entities', 'players', 'raycast', 'container']).describe('World query.'),
      x: z.number().optional().describe('Block X for action:"block".'),
      y: z.number().optional().describe('Block Y for action:"block".'),
      z: z.number().optional().describe('Block Z for action:"block".'),
      from: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe('Lower corner (inclusive) for action:"blocks".'),
      to: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe('Upper corner (inclusive) for action:"blocks".'),
      radius: z.number().min(1).max(128).optional().describe('Search radius in blocks for action:"entities" (default 32).'),
      type: z.string().optional().describe('Entity type filter for action:"entities", e.g. "minecraft:zombie" or "player".'),
      distance: z.number().min(0.5).max(128).optional().describe('Ray length in blocks for action:"raycast" (default 32).'),
      entities: z.boolean().optional().describe('Include entities in the raycast (default true).'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'state':
          return call('world.state', {});
        case 'block':
          return call('world.block', { x: num(args, 'x'), y: num(args, 'y'), z: num(args, 'z') });
        case 'blocks': {
          const from = vec(args, 'from');
          const to = vec(args, 'to');
          if (!from || !to) throw new McmcpError(-32602, 'action:"blocks" needs both "from" and "to" as {x,y,z}');
          return call('world.blocks', { from, to });
        }
        case 'entities':
          return call('world.entities', { radius: num(args, 'radius'), type: str(args, 'type') });
        case 'players':
          return call('world.players', {});
        case 'raycast':
          return call('world.raycast', { distance: num(args, 'distance'), entities: bool(args, 'entities') });
        case 'container':
          return call('world.container', {});
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}"`);
      }
    },
    format: (value, args) => {
      const action = str(args, 'action');
      if (action === 'entities' && Array.isArray(value)) {
        return value
          .map((raw) => {
            const e = isPlainObject(raw) ? raw : {};
            const pos = isPlainObject(e.position) ? e.position : {};
            const where = `${typeof pos.x === 'number' ? pos.x.toFixed(1) : '?'},${typeof pos.y === 'number' ? pos.y.toFixed(1) : '?'},${typeof pos.z === 'number' ? pos.z.toFixed(1) : '?'}`;
            return `#${String(e.id ?? '?')} ${String(e.type ?? e.name ?? '?').padEnd(28)} ${where.padEnd(20)} ${typeof e.distance === 'number' ? `${e.distance.toFixed(1)}m` : ''}`;
          })
          .join('\n');
      }
      if (action === 'players' && Array.isArray(value)) {
        return value
          .map((raw) => {
            const p = isPlainObject(raw) ? raw : {};
            return `${String(p.name ?? '?').padEnd(20)} ${String(p.ping ?? '?')} ms  ${String(p.gameMode ?? '')}`;
          })
          .join('\n');
      }
      if (action === 'blocks' && isPlainObject(value) && Array.isArray(value.blocks)) {
        const blocks = value.blocks
          .slice(0, 400)
          .map((raw) => {
            const b = isPlainObject(raw) ? raw : {};
            return `${String(b.x)},${String(b.y)},${String(b.z)} ${String(b.id ?? '?')}`;
          });
        const extra = value.truncated === true ? '\n(truncated by the mod)' : '';
        return `${String(value.blocks.length)} block(s)${extra}\n${blocks.join('\n')}`;
      }
      return JSON.stringify(value, null, 2);
    },
  },

  {
    name: 'mc_events',
    title: 'Poll game events',
    description:
      'Long-poll the event buffer for chat messages, screen opens/closes, joins/leaves, deaths, mod notices ' +
      'and (when subscribed) ticks. Returns as soon as something arrives or after timeoutMs. Pass the `next` ' +
      'value from the previous call as `after` so nothing is missed; omit `after` to get the most recent 50 ' +
      'events. `types` filters e.g. ["chat","screen"].',
    schema: {
      after: z.number().int().min(0).optional().describe('Return only events with seq > after (use the previous "next").'),
      timeoutMs: z.number().int().min(0).max(30_000).optional().describe('How long to wait for an event (default 5000 ms).'),
      types: z.array(z.string()).optional().describe('Event types to include, e.g. ["chat","screen","death","join","leave","log","tick"].'),
    },
    handler: async (args) => {
      const timeoutMs = num(args, 'timeoutMs') ?? 5000;
      const { client } = await getClient();
      const types = Array.isArray(args.types) ? args.types.filter((t): t is string => typeof t === 'string') : undefined;
      return client.events(num(args, 'after'), timeoutMs, types);
    },
    format: (value) => {
      if (!isPlainObject(value) || !Array.isArray(value.events)) return JSON.stringify(value, null, 2);
      if (value.events.length === 0) return `no events (next ${String(value.next ?? '?')})`;
      const rows = value.events.map((raw) => {
        const event = isPlainObject(raw) ? raw : {};
        return `#${String(event.seq ?? '?')} ${String(event.type ?? '?').padEnd(6)} ${JSON.stringify(event.data ?? {})}`;
      });
      return [`${value.events.length} event(s), next ${String(value.next ?? '?')}`, ...rows].join('\n');
    },
  },

  {
    name: 'mc_client',
    title: 'Client control',
    description:
      'Control the game client itself: connect to a server (address, port), disconnect, quit the game, take a ' +
      'screenshot, read window size/gui scale, or check health. action:"health" needs no JSON-RPC call and is ' +
      'the cheapest liveness check.',
    schema: {
      action: z.enum(['connect', 'disconnect', 'quit', 'screenshot', 'window', 'health']).describe('Client operation.'),
      address: z.string().optional().describe('Server address for action:"connect", e.g. "localhost" or "play.example.net".'),
      port: z.number().int().min(1).max(65535).optional().describe('Server port for action:"connect" (default 25565).'),
      name: z.string().optional().describe('Screenshot file name (without extension) for action:"screenshot".'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      switch (action) {
        case 'connect':
          return call('client.connect', { address: str(args, 'address'), port: num(args, 'port') });
        case 'disconnect':
          return call('client.disconnect', {});
        case 'quit':
          return call('client.quit', {});
        case 'screenshot':
          return call('client.screenshot', { name: str(args, 'name') });
        case 'window':
          return call('client.window', {});
        case 'health': {
          const { client, info } = await getClient(true);
          return { endpoint: client.address, health: info };
        }
        default:
          throw new McmcpError(-32602, `unknown action "${String(action)}"`);
      }
    },
  },

  {
    name: 'mc_raw',
    title: 'Raw method call',
    description:
      'Escape hatch: call any method from the mod catalog directly with arbitrary params. The method name is ' +
      'validated against /methods first, and the error lists the catalog when it is unknown. Prefer the typed ' +
      'tools (mc_player, mc_world, …) when they cover the call.',
    schema: {
      method: z.string().min(1).describe('Method name from the catalog, e.g. "player.state" or "mod.ping".'),
      params: z.record(z.unknown()).optional().describe('JSON-RPC params object (default {}).'),
    },
    handler: async (args) => {
      const method = str(args, 'method') ?? '';
      const { client } = await getClient();
      const list = await catalog(client);
      if (!list.some((spec) => spec.name === method)) {
        const names = list.map((spec) => spec.name).sort();
        throw new McmcpError(
          -32601,
          `unknown method "${method}". Available: ${names.join(', ')}`,
          { method, catalog: names },
        );
      }
      const raw = args.params;
      return call(method, isPlainObject(raw) ? raw : {});
    },
    format: (value) => JSON.stringify(value, null, 2),
  },

  {
    name: 'mc_instances',
    title: 'List Minecraft instances',
    description:
      'List Minecraft instances found on this machine (PrismLauncher native and Flatpak, plus ~/.minecraft) with ' +
      'their id, MC version, loader, whether the mcmcp mod is installed and its version. Local only: works ' +
      'without a running client. Use the id with mc_launch, mc_mod and mc_logs.',
    schema: {},
    handler: async () => ({ instances: listInstances() }),
    format: (value) => {
      const instances = isPlainObject(value) && Array.isArray(value.instances) ? (value.instances as Instance[]) : [];
      return formatInstances(instances);
    },
  },

  {
    name: 'mc_mod',
    title: 'Install or remove the mod',
    description:
      'Manage the mcmcp mod jar in instance mods/ folders. action:"status" reports which instances have it; ' +
      'action:"install" copies the newest built jar (or `jar`) into one instance or all Fabric instances, ' +
      'replacing older mcmcp jars; action:"uninstall" removes mcmcp jars. Non-Fabric instances are refused.',
    schema: {
      action: z.enum(['install', 'uninstall', 'status']).describe('Mod management operation.'),
      instance: z.string().optional().describe('Instance id or display name (from mc_instances).'),
      all: z.boolean().optional().describe('Apply to every Fabric instance.'),
      jar: z
        .string()
        .optional()
        .describe('Jar path to install (default: newest jar in mod/build/libs, or $MCMCP_MOD_JAR).'),
    },
    handler: async (args) => {
      const action = str(args, 'action');
      const all = bool(args, 'all') === true;
      const instanceId = str(args, 'instance');
      const instances = listInstances();

      if (action === 'status') {
        return { instances, jar: findBuiltJar() };
      }

      if (!all && !instanceId) {
        throw new McmcpError(
          -32602,
          'pass "instance" (see mc_instances) or "all":true to choose which instance(s) to change.',
        );
      }

      if (action === 'install') {
        const jar = str(args, 'jar') ?? findBuiltJar();
        if (!jar) {
          throw new McmcpError(
            -32000,
            'no built mod jar found. Build it (cd mod && ./gradlew build) or pass "jar", or set MCMCP_MOD_JAR.',
          );
        }
        const targets = all ? instances : [findInstance(instanceId ?? '')];
        const outcomes = installMod(targets, jar, { strict: !all, force: bool(args, 'force') });
        return { jar, outcomes };
      }

      if (action === 'uninstall') {
        const targets = all ? instances : [findInstance(instanceId ?? '')];
        const outcomes = targets.map((instance) => uninstallMod(instance));
        return { outcomes };
      }

      throw new McmcpError(-32602, `unknown action "${String(action)}" (expected install|uninstall|status)`);
    },
    format: (value) => {
      const v = isPlainObject(value) ? value : {};
      if (Array.isArray(v.instances) && v.outcomes === undefined) {
        return `${formatInstances(v.instances as Instance[])}${v.jar ? `\n\ndefault jar: ${String(v.jar)}` : ''}`;
      }
      const outcomes = Array.isArray(v.outcomes) ? v.outcomes : [];
      const lines = outcomes.map((raw) => {
        const o = isPlainObject(raw) ? raw : {};
        const inst = isPlainObject(o.instance) ? o.instance : {};
        const name = String(inst.id ?? '?');
        if (o.action === 'skipped') return `skipped  ${name}: ${String(o.reason ?? 'not Fabric')}`;
        const removed = Array.isArray(o.removed) && o.removed.length > 0 ? ` (removed ${o.removed.join(', ')})` : '';
        if (Array.isArray(o.removed) && o.path === undefined) {
          return `removed  ${name}: ${o.removed.length ? o.removed.join(', ') : 'nothing to remove'}`;
        }
        return `installed ${name}: ${String(o.path ?? '')}${removed}`;
      });
      return [v.jar ? `jar: ${String(v.jar)}` : '', ...lines].filter(Boolean).join('\n') || 'nothing to do';
    },
  },

  {
    name: 'mc_launch',
    title: 'Launch an instance',
    description:
      'Start a Minecraft instance through PrismLauncher (native or Flatpak) and, by default, wait until the ' +
      'mcmcp client answers /health (up to timeoutMs). Returns the instance, the command used and the live ' +
      'endpoint. The .minecraft instance cannot be launched this way - start it normally.',
    schema: {
      instance: z.string().min(1).describe('Instance id or display name from mc_instances.'),
      wait: z.boolean().optional().describe('Wait for the mod to come up (default true).'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .optional()
        .describe('How long to wait for the client (default 180000 ms).'),
    },
    handler: async (args) => {
      const result = await launchInstance(str(args, 'instance') ?? '', {
        wait: bool(args, 'wait') ?? true,
        timeoutMs: num(args, 'timeoutMs'),
      });
      return {
        instance: result.instance,
        via: result.via,
        command: result.command,
        pid: result.pid,
        endpoint: result.client?.client.address ?? null,
        health: result.client?.info ?? null,
      };
    },
    format: (value) => {
      const v = isPlainObject(value) ? value : {};
      const inst = isPlainObject(v.instance) ? v.instance : {};
      const lines = [
        `launched ${String(inst.id ?? '?')} via ${String(v.via ?? '?')}`,
        `command: ${Array.isArray(v.command) ? v.command.join(' ') : '?'}`,
      ];
      if (v.endpoint) lines.push(`endpoint: ${String(v.endpoint)}`);
      else lines.push('not waited for the client (--no-wait)');
      return lines.join('\n');
    },
  },

  {
    name: 'mc_logs',
    title: 'Read the game log',
    description:
      'Tail logs/latest.log of an instance (default 200 lines). Use it to diagnose a mod that failed to load, a ' +
      'crash, or why the control server did not start. Reads from disk, so no running client is required.',
    schema: {
      instance: z.string().optional().describe('Instance id or display name (defaults to the only instance found).'),
      lines: z.number().int().min(1).max(5000).optional().describe('Number of trailing lines (default 200).'),
    },
    handler: async (args) => {
      const instanceId = str(args, 'instance');
      const instance = instanceId ? findInstance(instanceId) : pickOnlyInstance();
      const tail = readInstanceLog(instance, num(args, 'lines') ?? 200);
      return { instance: instance.id, path: tail.path, lines: tail.lines };
    },
    format: (value) => {
      const v = isPlainObject(value) ? value : {};
      const lines = Array.isArray(v.lines) ? v.lines.map(String) : [];
      return [`# ${String(v.path ?? '')}`, ...lines].join('\n');
    },
  },
];

function pickOnlyInstance(): Instance {
  const instances = listInstances();
  if (instances.length === 1) {
    const only = instances[0];
    if (only) return only;
  }
  if (instances.length === 0) {
    throw new McmcpError(-32000, 'no Minecraft instances found on this machine.');
  }
  throw new McmcpError(
    -32602,
    `several instances found; pass "instance". Known ids: ${instances.map((i) => i.id).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/** Register every tool on an McpServer. */
export function registerTools(server: McpServer): void {
  for (const def of TOOL_DEFS) {
    server.tool(
      def.name,
      def.description,
      def.schema as Record<string, z.ZodTypeAny>,
      async (args: ToolArgs): Promise<CallToolResult> => execute(def, args),
    );
  }
}

/** Names of the registered tools (for `mcmcp tools`). */
export function toolNames(): string[] {
  return TOOL_DEFS.map((def) => def.name);
}

export function toolSummary(): { name: string; title: string; description: string }[] {
  return TOOL_DEFS.map((def) => ({ name: def.name, title: def.title, description: def.description }));
}

export { failure as toolError, success as toolSuccess };

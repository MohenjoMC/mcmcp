/**
 * OpenCode configuration wiring.
 *
 * v2 (OpenCode ≥ 2, e.g. 2.2.0) uses `{"mcp":{"servers":{name:{…}}}}`.
 * v1 uses `{"mcp":{name:{…}}}`. Both accept `type: "local"` with a command
 * array. We detect the existing shape and merge into it, never clobbering
 * unrelated keys or other MCP servers.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McmcpError } from './protocol.js';
import { expandHome, isCommandOnPath, pathExists } from './util.js';

export const SERVER_NAME = 'minecraft';
export const SERVER_COMMAND = ['mcmcp', 'serve'];

export type OpencodeShape = 'v1' | 'v2' | 'none';

export interface SetupOptions {
  /** Write the user-level config instead of a project one. */
  global?: boolean;
  /** Project directory (defaults to cwd). */
  projectDir?: string;
  /** Force the v1 shape even on a fresh file. */
  v1?: boolean;
  /** Override `~/.config/opencode` (tests). */
  globalDir?: string;
}

export interface SetupResult {
  path: string;
  shape: Exclude<OpencodeShape, 'none'>;
  /** File did not exist before. */
  created: boolean;
  /** The entry was added or changed. */
  changed: boolean;
  backup: string | null;
  command: string[];
  /** True when `mcmcp` could not be found on PATH. */
  commandMissing: boolean;
}

export interface OpencodeStatus {
  scope: 'global' | 'project';
  path: string;
  exists: boolean;
  shape: OpencodeShape;
  configured: boolean;
  command: string[] | null;
}

/** `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function defaultGlobalDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(expandHome(xdg), 'opencode');
  return path.join(homedir(), '.config', 'opencode');
}

/**
 * Pick the config file inside `dir`. OpenCode installs here may use
 * `opencode.jsonc`; prefer an existing file over creating a new one.
 */
export function resolveConfigPath(dir: string): string {
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (pathExists(jsonc)) return jsonc;
  if (pathExists(json)) return json;
  return json;
}

/** Remove `//` and block comments, preserving string contents. */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const len = text.length;
  let inString = false;
  while (i < len) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Remove trailing commas before `}` / `]`, preserving string contents. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const next = text[j];
      if (next === '}' || next === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Tolerant JSON(C) parse: comments and trailing commas are fine. */
export function parseJsonc(text: string): unknown {
  const cleaned = stripTrailingCommas(stripComments(text));
  if (cleaned.trim() === '') return {};
  return JSON.parse(cleaned) as unknown;
}

export function detectShape(config: Record<string, unknown>): OpencodeShape {
  const mcp = config.mcp;
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return 'none';
  const servers = (mcp as Record<string, unknown>).servers;
  if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) return 'v2';
  // v1: `mcp.<name>` entries carry a `type` field.
  for (const value of Object.values(mcp as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && 'type' in value) return 'v1';
  }
  return 'none';
}

function serverEntry(): { type: 'local'; command: string[]; enabled: boolean } {
  return { type: 'local', command: [...SERVER_COMMAND], enabled: true };
}

function readConfig(pathname: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(pathname, 'utf8');
  } catch (err) {
    throw new McmcpError(-32100, `cannot read ${pathname}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    throw new McmcpError(-32100, `cannot parse ${pathname}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McmcpError(-32100, `cannot parse ${pathname}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add (or refresh) the `minecraft` MCP server entry. Idempotent: re-running
 * with the same file rewrites it byte-identically and keeps one `.bak`.
 */
export function setup(opts: SetupOptions = {}): SetupResult {
  const projectDir = opts.projectDir ? path.resolve(expandHome(opts.projectDir)) : process.cwd();
  const file = opts.global
    ? resolveConfigPath(opts.globalDir ?? defaultGlobalDir())
    : path.join(projectDir, 'opencode.json');

  const created = !pathExists(file);
  let config: Record<string, unknown> = {};
  if (!created) config = readConfig(file);

  const detected = detectShape(config);
  const shape: Exclude<OpencodeShape, 'none'> = detected === 'none' ? (opts.v1 ? 'v1' : 'v2') : detected;

  const mcp = isPlainObject(config.mcp) ? config.mcp : {};
  const before = JSON.stringify(config);

  if (shape === 'v2') {
    const servers = isPlainObject(mcp.servers) ? mcp.servers : {};
    servers[SERVER_NAME] = serverEntry();
    mcp.servers = servers;
  } else {
    mcp[SERVER_NAME] = serverEntry();
  }
  config.mcp = mcp;
  if (typeof config.$schema !== 'string' && shape === 'v2') {
    config.$schema = 'https://opencode.ai/config.json';
  }

  // Keep $schema first for readability.
  const ordered: Record<string, unknown> = {};
  if ('$schema' in config) ordered.$schema = config.$schema;
  for (const [key, value] of Object.entries(config)) {
    if (key === '$schema') continue;
    ordered[key] = value;
  }

  const changed = JSON.stringify(ordered) !== before || created;
  const commandMissing = !isCommandOnPath('mcmcp');
  if (commandMissing) {
    process.stderr.write(
      'mcmcp: warning: "mcmcp" is not on PATH; the OpenCode entry was written anyway. ' +
        'Install it with "npm link" (or add the dist directory to PATH) before using it.\n',
    );
  }

  if (!changed) {
    return { path: file, shape, created: false, changed: false, backup: null, command: [...SERVER_COMMAND], commandMissing };
  }

  let backup: string | null = null;
  if (!created) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return { path: file, shape, created, changed, backup, command: [...SERVER_COMMAND], commandMissing };
}

function inspect(scope: 'global' | 'project', file: string): OpencodeStatus {
  const exists = pathExists(file);
  if (!exists) return { scope, path: file, exists, shape: 'none', configured: false, command: null };

  let config: Record<string, unknown>;
  try {
    config = readConfig(file);
  } catch {
    return { scope, path: file, exists, shape: 'none', configured: false, command: null };
  }
  const shape = detectShape(config);
  const mcp = isPlainObject(config.mcp) ? config.mcp : {};
  const bag = shape === 'v2' && isPlainObject(mcp.servers) ? mcp.servers : mcp;
  const entry = bag[SERVER_NAME];
  const configured = isPlainObject(entry);
  const rawCommand = isPlainObject(entry) ? entry.command : null;
  const command = Array.isArray(rawCommand) ? rawCommand.map(String) : null;
  return { scope, path: file, exists, shape, configured, command };
}

/** Where the `minecraft` server is configured (global and cwd project). */
export function status(opts: { projectDir?: string; globalDir?: string } = {}): OpencodeStatus[] {
  const projectDir = opts.projectDir ? path.resolve(expandHome(opts.projectDir)) : process.cwd();
  return [
    inspect('global', resolveConfigPath(opts.globalDir ?? defaultGlobalDir())),
    inspect('project', path.join(projectDir, 'opencode.json')),
  ];
}

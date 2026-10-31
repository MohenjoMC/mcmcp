/**
 * Configuration, token handling, runtime-descriptor discovery and client
 * resolution. Mirrors the "Discovery" section of docs/PROTOCOL.md.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McmcpError, ModClient, type HealthInfo, type RuntimeDescriptor } from './protocol.js';
import { expandHome, isPidAlive, pathExists, readTextFile } from './util.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 25585;

export interface McmcpConfig {
  host: string;
  port: number;
  tokenFile: string;
  allowRemote: boolean;
}

export interface ResolveOptions {
  host?: string;
  port?: number;
  /** Explicit token; wins over every other source. */
  token?: string;
  /** Talk to this base URL instead of host/port. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ResolvedClient {
  client: ModClient;
  info: HealthInfo;
  /** Where the address came from: env var, explicit option, or discovery. */
  source: 'env' | 'option' | 'discovery';
  descriptor?: RuntimeDescriptor;
}

/** `$XDG_CONFIG_HOME/mcmcp`, else `~/.config/mcmcp`. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(expandHome(xdg), 'mcmcp');
  return path.join(homedir(), '.config', 'mcmcp');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function clientsDir(): string {
  return path.join(configDir(), 'clients');
}

export function defaultTokenPath(): string {
  return path.join(configDir(), 'token');
}

export function defaultConfig(): McmcpConfig {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    tokenFile: defaultTokenPath(),
    allowRemote: false,
  };
}

/**
 * Read `config.json`, filling in defaults for anything missing. Throws a
 * helpful error when the file exists but is not valid JSON.
 */
export function loadConfig(): McmcpConfig {
  const base = defaultConfig();
  const file = configPath();
  const text = readTextFile(file);
  if (text === null) return base;

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new McmcpError(
      -32100,
      `cannot parse ${file}: ${(err as Error).message}. Fix it or run "mcmcp config init" to rewrite the defaults.`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McmcpError(-32100, `cannot parse ${file}: expected a JSON object.`);
  }

  const obj = raw as Record<string, unknown>;
  const host = typeof obj.host === 'string' && obj.host.trim() ? obj.host.trim() : base.host;
  const port =
    typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0 && obj.port < 65536
      ? obj.port
      : base.port;
  const tokenFile =
    typeof obj.tokenFile === 'string' && obj.tokenFile.trim() ? expandHome(obj.tokenFile.trim()) : base.tokenFile;
  const allowRemote = obj.allowRemote === true;
  return { host, port, tokenFile, allowRemote };
}

export function saveConfig(cfg: McmcpConfig): string {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return file;
}

/** Create the config dir (and `clients/`) if needed. */
export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(clientsDir(), { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Return the token in `file`, creating it (32 random bytes as hex, mode 0600)
 * when missing. An existing token is never overwritten.
 */
export function ensureToken(file: string = defaultTokenPath()): string {
  const target = path.resolve(expandHome(file));
  const existing = readTextFile(target)?.trim();
  if (existing) return existing;

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(target, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(target, 0o600);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process won the race; use whatever it wrote.
      const raced = readTextFile(target)?.trim();
      if (raced) return raced;
    }
    throw new McmcpError(-32100, `cannot create token file ${target}: ${(err as Error).message}`);
  }
}

function parseDescriptor(raw: unknown): RuntimeDescriptor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const pid = typeof obj.pid === 'number' ? obj.pid : Number.NaN;
  const port = typeof obj.port === 'number' ? obj.port : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const descriptor: RuntimeDescriptor = {
    pid,
    port,
    mcVersion: typeof obj.mcVersion === 'string' ? obj.mcVersion : 'unknown',
    modVersion: typeof obj.modVersion === 'string' ? obj.modVersion : 'unknown',
    player: typeof obj.player === 'string' ? obj.player : null,
    startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : 0,
  };
  if (typeof obj.host === 'string' && obj.host.trim()) descriptor.host = obj.host.trim();
  return descriptor;
}

/**
 * Live runtime descriptors from `clients/*.json`, newest first. Files whose
 * process is gone (or that cannot be parsed) are deleted.
 */
export function readDescriptors(): RuntimeDescriptor[] {
  const dir = clientsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const live: RuntimeDescriptor[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let parsed: RuntimeDescriptor | null = null;
    try {
      parsed = parseDescriptor(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    } catch {
      parsed = null;
    }
    if (!parsed || !isPidAlive(parsed.pid)) {
      // Stale or corrupt: the protocol says a dead process is ignored, and a
      // leftover file would confuse the next run, so remove it.
      try {
        rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    live.push(parsed);
  }
  live.sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
  return live;
}

export function tokenPermissions(file: string): { exists: boolean; mode: string | null; private: boolean } {
  try {
    const mode = statSync(file).mode & 0o777;
    return { exists: true, mode: mode.toString(8).padStart(3, '0'), private: mode === 0o600 };
  } catch {
    return { exists: false, mode: null, private: false };
  }
}

/**
 * Resolve the bearer token in protocol order: explicit option, `MCMCP_TOKEN`,
 * the config's `tokenFile`, then the default token path (created if missing).
 */
export function resolveToken(explicit?: string): string {
  return tokenFromSources(explicit).token;
}

function tokenFromSources(explicit?: string): { token: string; source: string } {
  const direct = explicit?.trim();
  if (direct) return { token: direct, source: 'explicit token' };

  const fromEnv = process.env.MCMCP_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'MCMCP_TOKEN' };

  const cfg = loadConfig();
  const configured = path.resolve(expandHome(cfg.tokenFile));
  const fallback = defaultTokenPath();
  for (const candidate of [configured, fallback]) {
    if (!pathExists(candidate)) continue;
    const token = readTextFile(candidate)?.trim();
    if (token) return { token, source: candidate };
  }

  // Nothing exists yet: create the configured file (default when unset).
  const target = configured || fallback;
  return { token: ensureToken(target), source: target };
}

function urlSource(): string | null {
  const raw = process.env.MCMCP_URL?.trim();
  return raw ? raw : null;
}

function envPort(): number | null {
  const raw = process.env.MCMCP_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function startHint(): string {
  return [
    'Start Minecraft with a Fabric instance that has the mcmcp mod installed:',
    '  mcmcp instances              # find the instance id',
    '  mcmcp launch <instance>      # start it and wait for the mod',
    'Then check "mcmcp status". Set MCMCP_URL/MCMCP_PORT to target a client directly.',
  ].join('\n');
}

async function probe(
  client: ModClient,
  source: ResolvedClient['source'],
  descriptor?: RuntimeDescriptor,
): Promise<ResolvedClient | { error: string }> {
  try {
    const info = await client.health(2000);
    const resolved: ResolvedClient = { client, info, source };
    if (descriptor) resolved.descriptor = descriptor;
    return resolved;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function clientFor(url: string, token: string, timeoutMs?: number): ModClient {
  const parsed = new URL(url);
  return new ModClient({
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    token,
    timeoutMs,
  });
}

/**
 * Find a Minecraft client and verify it answers `/health`.
 *
 * Address precedence: `MCMCP_URL`, then `MCMCP_PORT`/`MCMCP_HOST`, then explicit
 * options, then runtime-descriptor discovery (newest healthy client).
 * Token precedence: explicit option, `MCMCP_TOKEN`, config `tokenFile`, default.
 */
export async function resolveClient(opts: ResolveOptions = {}): Promise<ResolvedClient> {
  const { token } = tokenFromSources(opts.token);
  const timeoutMs = opts.timeoutMs;

  const envUrl = urlSource();
  if (envUrl) {
    const client = clientFor(envUrl, token, timeoutMs);
    const probed = await probe(client, 'env');
    if ('error' in probed) {
      throw new McmcpError(-32000, `MCMCP_URL=${envUrl} does not answer /health (${probed.error}).`);
    }
    return probed;
  }

  const port = envPort();
  if (port) {
    const host = process.env.MCMCP_HOST?.trim() || opts.host || DEFAULT_HOST;
    const client = new ModClient({ host, port, token, timeoutMs });
    const probed = await probe(client, 'env');
    if ('error' in probed) {
      throw new McmcpError(-32000, `MCMCP_PORT=${port} on ${host} does not answer /health (${probed.error}).`);
    }
    return probed;
  }

  if (opts.baseUrl) {
    const client = clientFor(opts.baseUrl, token, timeoutMs);
    const probed = await probe(client, 'option');
    if ('error' in probed) {
      throw new McmcpError(-32000, `${opts.baseUrl} does not answer /health (${probed.error}).`);
    }
    return probed;
  }

  if (opts.port !== undefined) {
    const host = opts.host ?? DEFAULT_HOST;
    const client = new ModClient({ host, port: opts.port, token, timeoutMs });
    const probed = await probe(client, 'option');
    if ('error' in probed) {
      throw new McmcpError(-32000, `${host}:${opts.port} does not answer /health (${probed.error}). ${startHint()}`);
    }
    return probed;
  }

  const descriptors = readDescriptors();
  if (descriptors.length === 0) {
    throw new McmcpError(
      -32000,
      `no Minecraft client found (no live runtime descriptors in ${clientsDir()}).\n${startHint()}`,
    );
  }

  const cfg = loadConfig();
  const attempts = await Promise.all(
    descriptors.map(async (descriptor) => {
      const client = new ModClient({
        host: descriptor.host ?? cfg.host,
        port: descriptor.port,
        token,
        timeoutMs,
      });
      return probe(client, 'discovery', descriptor);
    }),
  );

  const healthy = attempts.filter((a): a is ResolvedClient => !('error' in a));
  if (healthy.length === 0) {
    const pids = descriptors.map((d) => `pid ${d.pid} on port ${d.port}`).join(', ');
    throw new McmcpError(
      -32000,
      `${descriptors.length} mcmcp client descriptor(s) found (${pids}) but none answered /health. ` +
        'The game may still be starting, or the control server was shut down.',
    );
  }
  healthy.sort((a, b) => (b.descriptor?.startedAt ?? 0) - (a.descriptor?.startedAt ?? 0));
  const newest = healthy[0];
  if (!newest) throw new McmcpError(-32000, 'no healthy Minecraft client found.');
  return newest;
}

/** Base URL a resolved client points at, for display. */
export function addressOf(resolved: ResolvedClient): string {
  return resolved.client.address;
}

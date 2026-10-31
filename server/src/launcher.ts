/**
 * Launch a Minecraft instance through its launcher and wait for the mcmcp mod
 * to appear (a new runtime descriptor that answers `/health`).
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McmcpError, ModClient } from './protocol.js';
import { readDescriptors, resolveToken, type ResolvedClient } from './config.js';
import { findInstance, type Instance, type InstanceRoot } from './instances.js';
import { findOnPath, pathExists } from './util.js';

export interface LaunchOptions {
  /** Wait for the mod to come up (default true). */
  wait?: boolean;
  /** How long to wait for a new client (default 180 s). */
  timeoutMs?: number;
  /** Override the instance roots (tests). */
  roots?: InstanceRoot[];
}

export interface LaunchResult {
  instance: Instance;
  /** How the game was started. */
  via: 'prism' | 'prism-flatpak' | 'manual';
  command: string[];
  pid: number | null;
  /** Present when `wait` was true and the mod appeared in time. */
  client?: ResolvedClient;
}

const PRISM_BINARIES = ['prismlauncher', 'PrismLauncher'];
const FLATPAK_APP = 'org.prismlauncher.PrismLauncher';
const DEFAULT_TIMEOUT = 180_000;
const MIN_POLL = 250;
const MAX_POLL = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn detached and resolve once the process exists (so ENOENT is reported). */
function spawnDetached(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    const onError = (err: Error): void => {
      reject(new McmcpError(-32100, `cannot start ${command}: ${err.message}`));
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      child.unref();
      resolve(child.pid ?? null);
    });
  });
}

function buildCommand(instance: Instance): { command: string[]; via: LaunchResult['via'] } {
  if (instance.launcher === 'vanilla') {
    throw new McmcpError(
      -32003,
      `instance "${instance.id}" is a plain .minecraft directory, which has no launcher command. ` +
        'Start Minecraft the way you normally do (official launcher, MultiMC, …) and run "mcmcp status" afterwards.',
    );
  }

  if (instance.launcher === 'prism-flatpak') {
    const flatpak = findOnPath(['flatpak']);
    if (!flatpak) {
      throw new McmcpError(
        -32100,
        'this instance belongs to the Flatpak PrismLauncher, but "flatpak" is not on PATH. ' +
          `Start it manually: flatpak run ${FLATPAK_APP} -l ${instance.id}`,
      );
    }
    return { command: [flatpak, 'run', FLATPAK_APP, '-l', instance.id], via: 'prism-flatpak' };
  }

  const binary = findPrismBinary();
  if (!binary) {
    throw new McmcpError(
      -32100,
      `PrismLauncher not found (tried ${PRISM_BINARIES.join(', ')} on PATH, AppImages under ~/Applications and ~/AppImages). ` +
        'Set MCMCP_PRISM to its executable, or start the instance ' +
        `"${instance.id}" manually and run "mcmcp status".`,
    );
  }
  return { command: [binary, '-l', instance.id], via: 'prism' };
}

/**
 * Launch an instance by id (or display name) and, unless `wait:false`, block
 * until a brand-new client descriptor answers `/health`.
 */
export async function launchInstance(id: string, opts: LaunchOptions = {}): Promise<LaunchResult> {
  const instance = findInstance(id, opts.roots ? { roots: opts.roots } : {});
  const { command, via } = buildCommand(instance);

  const before = new Set(readDescriptors().map((d) => d.pid));
  const pid = await spawnDetached(command[0] as string, command.slice(1));

  const result: LaunchResult = { instance, via, command, pid };
  if (opts.wait === false) return result;

  const token = resolveToken();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const deadline = Date.now() + timeoutMs;
  let delay = MIN_POLL;
  let lastProblem = '';

  while (Date.now() < deadline) {
    const fresh = readDescriptors().filter((d) => !before.has(d.pid));
    for (const descriptor of fresh) {
      const client = new ModClient({ host: descriptor.host ?? '127.0.0.1', port: descriptor.port, token });
      try {
        const info = await client.health(1500);
        result.client = { client, info, source: 'discovery', descriptor };
        return result;
      } catch (err) {
        lastProblem = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(MAX_POLL, Math.round(delay * 1.6));
  }

  const suffix = lastProblem ? ` Last error from a new client: ${lastProblem}` : '';
  throw new McmcpError(
    -32001,
    `started ${command.join(' ')} but no mcmcp client appeared within ${Math.round(timeoutMs / 1000)}s.` +
      ' The game may still be loading, or the mcmcp mod is not installed in this instance ' +
      `("mcmcp install --instance ${instance.id}").${suffix}`,
  );
}

/**
 * Prism is often distributed as an AppImage: look on PATH first, then in the
 * usual download folders, then an explicit MCMCP_PRISM override wins.
 */
export function findPrismBinary(): string | null {
  const override = process.env.MCMCP_PRISM;
  if (override && pathExists(override)) return override;
  const onPath = findOnPath(PRISM_BINARIES);
  if (onPath) return onPath;
  const configured = process.env.MCMCP_PRISM_DIRS;
  const directories = configured === undefined
    ? [
        path.join(homedir(), 'Applications'),
        path.join(homedir(), 'AppImages'),
        path.join(homedir(), 'Downloads'),
      ]
    : configured.split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    const match = entries
      .filter((entry) => /^prism.*\.(appimage|AppImage)$/i.test(entry))
      .sort((a, b) => Number(/bak|old/i.test(a)) - Number(/bak|old/i.test(b)))[0];
    if (match) return path.join(directory, match);
  }
  return null;
}

/**
 * Small filesystem / process helpers shared by the CLI, the MCP tools and the
 * config layer. No third-party dependencies on purpose.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) return path.join(homedir(), p.slice(2));
  return p;
}

export function pathExists(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Is `pid` a live process? `EPERM` means "exists but belongs to someone else",
 * which counts as alive.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Look up an executable on `PATH`, in the order the names are given. */
export function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    if (name.includes(path.sep)) {
      if (isExecutable(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

export function isCommandOnPath(name: string): boolean {
  return findOnPath([name]) !== null;
}

/** First N characters of a string, with an ellipsis marker when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `ms` as a short human string (`3.2s`). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

/** Truncate a value's JSON representation and report how big it was. */
export function jsonPreview(value: unknown, max = 20_000): { text: string; truncated: boolean; length: number } {
  const text = JSON.stringify(value, null, 2);
  const length = text.length;
  if (length <= max) return { text, truncated: false, length };
  return { text: `${text.slice(0, max)}\n… (${length - max} more characters, output truncated)`, truncated: true, length };
}

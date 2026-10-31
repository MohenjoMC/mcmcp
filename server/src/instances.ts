/**
 * Minecraft instance discovery and mod installation.
 *
 * Supported launchers:
 *  - PrismLauncher (native: ~/.local/share/PrismLauncher/instances)
 *  - PrismLauncher (Flatpak: ~/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances)
 *  - vanilla ~/.minecraft
 *
 * Prism stores everything we need per instance: `instance.cfg` (Name=…),
 * `mmc-pack.json` (component versions) and the game directory itself
 * (`minecraft/` unless `OverrideGameDir` is set).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McmcpError } from './protocol.js';
import { expandHome, isDirectory, pathExists, readTextFile } from './util.js';

export type LauncherKind = 'prism' | 'prism-flatpak' | 'vanilla';
export type LoaderKind = 'fabric' | 'forge' | 'unknown';

export interface Instance {
  /** Stable id used by `-l <id>` (Prism: directory name; vanilla: "vanilla"). */
  id: string;
  name: string;
  launcher: LauncherKind;
  /** Instance directory (Prism) or the launcher root (vanilla). */
  path: string;
  gameDir: string;
  modsDir: string;
  mcVersion: string | null;
  loader: LoaderKind;
  loaderVersion: string | null;
  /** True when the mcmcp jar is present in `mods/`. */
  hasMod: boolean;
  modVersion: string | null;
  /** Convenience: the instance can run the mod. */
  fabric: boolean;
}

export interface InstanceRoot {
  launcher: LauncherKind;
  dir: string;
}

export interface InstallOutcome {
  instance: Instance;
  action: 'installed' | 'skipped';
  /** Destination jar path when installed. */
  path?: string;
  /** Old mcmcp jars that were removed. */
  removed: string[];
  /** Why the instance was skipped. */
  reason?: string;
}

export interface UninstallOutcome {
  instance: Instance;
  removed: string[];
}

/** Every jar we manage is named `mcmcp…jar`. */
const ANY_MOD_JAR_PATTERN = /^mcmcp.*\.jar$/i;

/** All Prism/vanilla roots that exist on this machine, in priority order. */
export function discoverRoots(): InstanceRoot[] {
  const home = homedir();
  const candidates: InstanceRoot[] = [
    { launcher: 'prism', dir: path.join(home, '.local', 'share', 'PrismLauncher', 'instances') },
    {
      launcher: 'prism-flatpak',
      dir: path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances'),
    },
    { launcher: 'vanilla', dir: path.join(home, '.minecraft') },
  ];
  return candidates.filter((root) => isDirectory(root.dir));
}

/** Parse a Prism `instance.cfg` (key=value, `#` comments). */
export function parseInstanceCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

interface MmcComponent {
  uid?: string;
  version?: string;
}

interface MmcPack {
  components?: MmcComponent[];
}

export function parseMmcPack(text: string): MmcPack {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const components = (raw as MmcPack).components;
      return { components: Array.isArray(components) ? components : [] };
    }
  } catch {
    /* fall through */
  }
  return { components: [] };
}

/** Extract the version from a jar name such as `mcmcp-1.0.0+26.1.2.jar` or `mcmcp-fabric-26.1.2-1.0.0.jar`. */
export function parseModVersion(fileName: string): string | null {
  const base = fileName.replace(/\.jar$/i, '');
  // Strip the "mcmcp" prefix; whatever remains may carry a loader tag and MC version.
  const rest = base.replace(/^mcmcp[-._]?/i, '');
  const strict = rest.match(/\d+\.\d+\.\d+(?:\+[0-9A-Za-z.+_-]+)?/g);
  if (strict && strict.length > 0) return strict[strict.length - 1] ?? null;
  const loose = rest.match(/\d+\.\d+/g);
  return loose && loose.length > 0 ? (loose[loose.length - 1] ?? null) : null;
}

/** mcmcp jars in `mods/`, oldest first (so the last entry is the newest build). */
export function findModJars(modsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(modsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => ANY_MOD_JAR_PATTERN.test(name))
    .map((name) => {
      let mtime = 0;
      try {
        mtime = statSync(path.join(modsDir, name)).mtimeMs;
      } catch {
        /* keep 0 */
      }
      return { name, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}

function detectVanilla(dir: string): {
  mcVersion: string | null;
  loader: LoaderKind;
  loaderVersion: string | null;
} {
  const versionsDir = path.join(dir, 'versions');
  let names: string[] = [];
  try {
    names = readdirSync(versionsDir);
  } catch {
    return { mcVersion: null, loader: 'unknown', loaderVersion: null };
  }

  const fabricEntry = names.find((name) => /^fabric-loader[-_]/i.test(name));
  if (fabricEntry) {
    // Folders look like `fabric-loader-0.16.10-1.21.5`.
    const parts = fabricEntry.match(/^fabric-loader[-_](.+?)[-_](\d+\.\d+(?:\.\d+)?)$/i);
    if (parts) {
      return { mcVersion: parts[2] ?? null, loader: 'fabric', loaderVersion: parts[1] ?? null };
    }
    const loaderVersion = fabricEntry.replace(/^fabric-loader[-_]/i, '');
    const mcFromFolder = fabricEntry.match(/\d+\.\d+(?:\.\d+)?/);
    return { mcVersion: mcFromFolder?.[0] ?? null, loader: 'fabric', loaderVersion };
  }

  // Best effort: newest version folder that has a matching json.
  let best: { name: string; mtime: number } | null = null;
  for (const name of names) {
    if (!pathExists(path.join(versionsDir, name, `${name}.json`))) continue;
    let mtime = 0;
    try {
      mtime = statSync(path.join(versionsDir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { name, mtime };
  }
  if (best) {
    const mcVersion = best.name.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
    return { mcVersion, loader: 'unknown', loaderVersion: null };
  }
  return { mcVersion: null, loader: 'unknown', loaderVersion: null };
}

function buildInstance(root: InstanceRoot, instanceDir: string, id: string): Instance | null {
  const cfgFile = path.join(instanceDir, 'instance.cfg');
  if (!pathExists(cfgFile) && !pathExists(path.join(instanceDir, 'mmc-pack.json'))) return null;

  const cfg = parseInstanceCfg(readTextFile(cfgFile) ?? '');
  const packFile = path.join(instanceDir, 'mmc-pack.json');
  const pack = parseMmcPack(readTextFile(packFile) ?? '');
  const components = pack.components ?? [];

  const component = (uid: string): string | null => {
    const found = components.find((c) => c.uid === uid);
    return found?.version ?? null;
  };

  const mcVersion = component('net.minecraft');
  const fabricVersion = component('net.fabricmc.fabric-loader');
  const forgeVersion = component('net.minecraftforge');
  const loader: LoaderKind = fabricVersion ? 'fabric' : forgeVersion ? 'forge' : 'unknown';

  const overrideGameDir = cfg.OverrideGameDir?.trim();
  const gameDir = overrideGameDir ? path.resolve(expandHome(overrideGameDir)) : path.join(instanceDir, 'minecraft');
  const modsDir = path.join(gameDir, 'mods');

  const jars = findModJars(modsDir);
  const jar = jars[jars.length - 1] ?? null;

  return {
    id,
    name: cfg.name?.trim() || id,
    launcher: root.launcher,
    path: instanceDir,
    gameDir,
    modsDir,
    mcVersion,
    loader,
    loaderVersion: fabricVersion ?? forgeVersion ?? null,
    hasMod: jar !== null,
    modVersion: jar ? parseModVersion(jar) : null,
    fabric: loader === 'fabric',
  };
}

function buildVanillaInstance(root: InstanceRoot): Instance {
  const detected = detectVanilla(root.dir);
  const modsDir = path.join(root.dir, 'mods');
  const jars = findModJars(modsDir);
  const jar = jars[jars.length - 1] ?? null;
  return {
    id: 'vanilla',
    name: '.minecraft',
    launcher: 'vanilla',
    path: root.dir,
    gameDir: root.dir,
    modsDir,
    mcVersion: detected.mcVersion,
    loader: detected.loader,
    loaderVersion: detected.loaderVersion,
    hasMod: jar !== null,
    modVersion: jar ? parseModVersion(jar) : null,
    fabric: detected.loader === 'fabric',
  };
}

/**
 * Every instance we can see. Pass `roots` to scan a different tree (tests do).
 */
export function listInstances(opts: { roots?: InstanceRoot[] } = {}): Instance[] {
  const roots = opts.roots ?? discoverRoots();
  const instances: Instance[] = [];

  for (const root of roots) {
    if (root.launcher === 'vanilla') {
      instances.push(buildVanillaInstance(root));
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const id of entries.sort()) {
      const built = buildInstance(root, path.join(root.dir, id), id);
      if (built) instances.push(built);
    }
  }

  return instances;
}

/** Case-insensitive lookup by id, then by display name. */
export function findInstance(idOrName: string, opts: { roots?: InstanceRoot[] } = {}): Instance {
  const instances = listInstances(opts);
  const needle = idOrName.trim().toLowerCase();
  const byId = instances.find((i) => i.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = instances.find((i) => i.name.toLowerCase() === needle);
  if (byName) return byName;

  const available = instances.map((i) => `  ${i.id}  (${i.name}, ${i.launcher}${i.mcVersion ? `, MC ${i.mcVersion}` : ''})`).join('\n');
  throw new McmcpError(
    -32000,
    instances.length
      ? `no instance matching "${idOrName}". Known instances:\n${available}`
      : `no Minecraft instances found. Looked in:\n${(opts.roots ?? discoverRoots()).map((r) => `  ${r.dir}`).join('\n') || '  (no launcher directories exist)'}`,
  );
}

/**
 * Copy `jarPath` into each instance's `mods/` dir, replacing older mcmcp jars.
 * Throws when a non-Fabric instance is targeted in strict mode (the default,
 * used for a single explicitly named instance); pass `strict: false` for
 * "install everywhere" so non-Fabric instances are reported as skipped.
 */
export function installMod(
  instances: Instance[],
  jarPath: string,
  opts: { strict?: boolean; force?: boolean } = {},
): InstallOutcome[] {
  const strict = opts.strict ?? true;
  const force = opts.force ?? false;
  const jar = path.resolve(expandHome(jarPath));
  if (!pathExists(jar)) {
    throw new McmcpError(-32000, `mod jar not found: ${jar}. Build it with "cd mod && ./gradlew build".`);
  }
  if (!jar.toLowerCase().endsWith('.jar')) {
    throw new McmcpError(-32002, `refusing to install a file that is not a jar: ${jar}`);
  }
  if (instances.length === 0) {
    throw new McmcpError(-32000, 'no instances to install into.');
  }

  const sourceName = path.basename(jar);
  const minecraftDependency = jarMinecraftDependency(jar);
  const outcomes: InstallOutcome[] = [];

  for (const instance of instances) {
    if (!force && instance.mcVersion && !minecraftSatisfies(instance.mcVersion, minecraftDependency)) {
      const reason = `builds for minecraft ${minecraftDependency ?? 'unknown'}, instance runs ${instance.mcVersion}`;
      if (strict) {
        throw new McmcpError(
          -32003,
          `cannot install ${sourceName} into "${instance.id}": ${reason}. ` +
            'Build a jar for that version (see docs/ARCHITECTURE.md#version-support) or pass --force.',
        );
      }
      outcomes.push({ instance, action: 'skipped', removed: [], reason });
      continue;
    }
    if (!instance.fabric) {
      if (strict) {
        const why =
          instance.loader === 'unknown'
            ? 'its loader could not be determined from mmc-pack.json'
            : `it uses ${instance.loader}`;
        throw new McmcpError(
          -32003,
          `cannot install mcmcp into "${instance.id}": ${why}. mcmcp is a Fabric mod; ` +
            'use the Fabric loader (Prism: Edit → Version → Fabric) or pick another instance.',
        );
      }
      outcomes.push({
        instance,
        action: 'skipped',
        removed: [],
        reason: instance.loader === 'unknown' ? 'loader unknown (not Fabric)' : `loader is ${instance.loader}, not Fabric`,
      });
      continue;
    }

    mkdirSync(instance.modsDir, { recursive: true });
    const removed: string[] = [];
    // Never install over ourselves silently, but do remove older builds.
    for (const existing of readdirSync(instance.modsDir)) {
      if (!ANY_MOD_JAR_PATTERN.test(existing)) continue;
      if (existing === sourceName) continue;
      try {
        unlinkSync(path.join(instance.modsDir, existing));
        removed.push(existing);
      } catch {
        /* leave a locked file in place; the copy below still works */
      }
    }

    const destination = path.join(instance.modsDir, sourceName);
    copyFileSync(jar, destination);
    outcomes.push({ instance, action: 'installed', path: destination, removed });
  }

  return outcomes;
}

/** Remove every mcmcp jar from the instance's `mods/` dir. */
export function uninstallMod(instance: Instance): UninstallOutcome {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(instance.modsDir);
  } catch {
    return { instance, removed };
  }
  for (const entry of entries) {
    if (!ANY_MOD_JAR_PATTERN.test(entry)) continue;
    try {
      rmSync(path.join(instance.modsDir, entry), { force: true });
      removed.push(entry);
    } catch (err) {
      throw new McmcpError(-32100, `cannot remove ${entry} from ${instance.modsDir}: ${(err as Error).message}`);
    }
  }
  return { instance, removed };
}

/** Read the tail of `<gameDir>/logs/latest.log`. */
export function readInstanceLog(instance: Instance, lines = 200): { path: string; lines: string[] } {
  const logPath = path.join(instance.gameDir, 'logs', 'latest.log');
  const text = readTextFile(logPath);
  if (text === null) {
    throw new McmcpError(-32000, `no log file at ${logPath}. Has this instance been launched?`);
  }
  const want = Math.max(1, Math.min(lines, 5000));
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return { path: logPath, lines: all.slice(-want) };
}

/** Best-effort default jar: `MCMCP_MOD_JAR`, else newest jar under `mod/build/libs`. */
export function findBuiltJar(startDir = process.cwd()): string | null {
  const fromEnv = process.env.MCMCP_MOD_JAR?.trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));

  const candidates: string[] = [];
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth += 1) {
    const libs = path.join(dir, 'mod', 'build', 'libs');
    if (isDirectory(libs)) {
      candidates.push(libs);
      break;
    }
    if (path.basename(dir) === 'mod' && isDirectory(path.join(dir, 'build', 'libs'))) {
      candidates.push(path.join(dir, 'build', 'libs'));
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const libs of candidates) {
    let jars: { file: string; mtime: number }[] = [];
    try {
      jars = readdirSync(libs)
        .filter((name) => name.toLowerCase().endsWith('.jar') && !name.endsWith('-sources.jar'))
        .map((name) => {
          const full = path.join(libs, name);
          let mtime = 0;
          try {
            mtime = statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { file: full, mtime };
        });
    } catch {
      continue;
    }
    jars.sort((a, b) => b.mtime - a.mtime);
    const best = jars[0];
    if (best) return best.file;
  }
  return null;
}

/** Every built mod jar, newest first (excludes -sources). */
export function findBuiltJars(startDir = process.cwd()): string[] {
  const fromEnv = process.env.MCMCP_MOD_JAR?.trim();
  if (fromEnv) return [path.resolve(expandHome(fromEnv))];

  for (const libs of candidateLibDirs(startDir)) {
    try {
      return readdirSync(libs)
        .filter((name) => name.toLowerCase().endsWith('.jar') && !name.endsWith('-sources.jar'))
        .map((name) => {
          const full = path.join(libs, name);
          let mtime = 0;
          try {
            mtime = statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { file: full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map((entry) => entry.file);
    } catch {
      continue;
    }
  }
  return [];
}

function candidateLibDirs(startDir: string): string[] {
  const candidates: string[] = [];
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth += 1) {
    const libs = path.join(dir, 'mod', 'build', 'libs');
    if (isDirectory(libs)) {
      candidates.push(libs);
      break;
    }
    if (path.basename(dir) === 'mod' && isDirectory(path.join(dir, 'build', 'libs'))) {
      candidates.push(path.join(dir, 'build', 'libs'));
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/** The newest jar whose declared Minecraft range accepts this instance. */
export function jarForInstance(jars: string[], mcVersion: string | null): string | null {
  if (!mcVersion) return jars[0] ?? null;
  for (const jar of jars) {
    if (minecraftSatisfies(mcVersion, jarMinecraftDependency(jar))) return jar;
  }
  return null;
}

export interface SmartInstallOutcome extends InstallOutcome {
  jar?: string;
}

/**
 * Install the matching jar into each instance: one build per Minecraft line means a
 * mixed launcher gets 26.1.2 into its 26.1.2 instances and 1.21.11 into the 1.21.11 ones.
 */
export function installMatching(
  instances: Instance[],
  jars: string[],
  opts: { strict?: boolean; force?: boolean; explicitJar?: string } = {},
): SmartInstallOutcome[] {
  const outcomes: SmartInstallOutcome[] = [];
  for (const instance of instances) {
    const jar = opts.explicitJar ?? jarForInstance(jars, instance.mcVersion);
    if (!jar) {
      outcomes.push({
        instance,
        action: 'skipped',
        removed: [],
        reason: `no built jar for minecraft ${instance.mcVersion ?? 'unknown'} (build the matrix entry first)`,
      });
      continue;
    }
    for (const outcome of installMod([instance], jar, { strict: opts.strict, force: opts.force })) {
      outcomes.push({ ...outcome, jar });
    }
  }
  return outcomes;
}

/** Read `depends.minecraft` from the jar's fabric.mod.json, e.g. "~26.1". */
export function jarMinecraftDependency(jar: string): string | null {
  try {
    const raw = execFileSync('unzip', ['-p', jar, 'fabric.mod.json'], { encoding: 'utf8', timeout: 10_000 });
    const parsed = JSON.parse(raw) as { depends?: Record<string, string> };
    return parsed.depends?.minecraft ?? null;
  } catch {
    // unzip missing or not a Fabric jar: fall back to the build target in the file name.
    const match = /\+(\d+\.\d+(?:\.\d+)?)\.jar$/i.exec(path.basename(jar));
    const target = match?.[1];
    return target ? `~${target.split('.').slice(0, 2).join('.')}` : null;
  }
}

/** Minimal comparator for the dependency syntaxes Fabric mods actually use. */
export function minecraftSatisfies(version: string, dependency: string | null): boolean {
  if (!dependency || dependency === '*') return true;
  const parse = (value: string): number[] => value.split(/[.\-+]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version);
  const compare = (wanted: number[]): number => {
    for (let i = 0; i < 3; i += 1) {
      const a = have[i] ?? 0;
      const b = wanted[i] ?? 0;
      if (a !== b) return a - b;
    }
    return 0;
  };
  for (const clause of dependency.split(' ')) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const operator = /^(>=|<=|>|<|=|~|\^)/.exec(trimmed)?.[1] ?? '=';
    const wanted = parse(trimmed.slice(operator.length));
    const diff = compare(wanted);
    const ok =
      operator === '>=' ? diff >= 0
      : operator === '<=' ? diff <= 0
      : operator === '>' ? diff > 0
      : operator === '<' ? diff < 0
      : operator === '~' || operator === '^' ? have[0] === wanted[0] && have[1] === wanted[1] && diff >= 0
      : diff === 0;
    if (ok) return true;
  }
  return false;
}

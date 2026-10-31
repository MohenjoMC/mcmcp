/**
 * `mcmcp doctor`: a one-shot health report for everything the bridge depends on.
 * PASS/WARN/FAIL lines, no side effects beyond creating the config dir/token.
 */

import { createServer as createNetServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readDescriptors, configDir, configPath, defaultTokenPath, ensureToken, loadConfig, tokenPermissions } from './config.js';
import { findBuiltJars, jarForInstance, listInstances } from './instances.js';
import { findPrismBinary } from './launcher.js';
import { status as opencodeStatus, SERVER_COMMAND } from './opencode.js';
import { McmcpError, ModClient } from './protocol.js';
import { formatDuration, isCommandOnPath, pathExists } from './util.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface Check {
  status: CheckStatus;
  label: string;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  failed: number;
  warned: number;
  /** Exit code: 1 when something is broken. */
  exitCode: number;
  lines(): string[];
}

function line(check: Check): string {
  return `${check.status.padEnd(5)} ${check.label.padEnd(22)} ${check.detail}`;
}

function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkPort(port: number): Promise<Check> {
  const free = await isPortFree(port);
  if (free) return { status: 'PASS', label: 'port', detail: `${port} is free (no client running on it)` };

  // Something is listening. Is it us?
  try {
    const health = await new ModClient({ host: '127.0.0.1', port, token: ensureToken() }).health(1500);
    if (health.name === 'mcmcp') {
      return { status: 'PASS', label: 'port', detail: `${port} is served by mcmcp ${health.version} (MC ${health.mc})` };
    }
    return {
      status: 'WARN',
      label: 'port',
      detail: `${port} is in use by "${health.name}" - not mcmcp. The mod will pick another free port.`,
    };
  } catch {
    return {
      status: 'WARN',
      label: 'port',
      detail: `${port} is in use by another process (not answering /health). The mod will pick another free port.`,
    };
  }
}

export async function runDoctor(opts: { projectDir?: string } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];

  // Node version.
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    status: major >= 20 ? 'PASS' : 'FAIL',
    label: 'node',
    detail: `${process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`,
  });

  // Config dir writable.
  const dir = configDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    checks.push({ status: 'PASS', label: 'config dir', detail: dir });
  } catch (err) {
    checks.push({ status: 'FAIL', label: 'config dir', detail: `${dir} is not writable (${(err as Error).message})` });
  }

  // Config file.
  let port = 25585;
  try {
    const cfg = loadConfig();
    port = cfg.port;
    checks.push({
      status: 'PASS',
      label: 'config',
      detail: pathExists(configPath())
        ? `${configPath()} (host ${cfg.host}, port ${cfg.port}, allowRemote ${cfg.allowRemote})`
        : `no config file; using defaults (host ${cfg.host}, port ${cfg.port})`,
    });
  } catch (err) {
    checks.push({ status: 'FAIL', label: 'config', detail: err instanceof McmcpError ? err.message : String(err) });
  }

  // Token.
  const cfgToken = (() => {
    try {
      return loadConfig().tokenFile;
    } catch {
      return defaultTokenPath();
    }
  })();
  try {
    const token = ensureToken(cfgToken);
    const perms = tokenPermissions(cfgToken);
    checks.push({
      status: perms.private ? 'PASS' : 'WARN',
      label: 'token',
      detail: `${cfgToken} (mode ${perms.mode ?? '?'}, ${token.length / 2} bytes)${perms.private ? '' : ` - should be 0600; run: chmod 600 ${cfgToken}`}`,
    });
  } catch (err) {
    checks.push({ status: 'FAIL', label: 'token', detail: err instanceof McmcpError ? err.message : String(err) });
  }

  // Running clients.
  const descriptors = readDescriptors();
  if (descriptors.length === 0) {
    checks.push({
      status: 'WARN',
      label: 'clients',
      detail: 'no running mcmcp client (start Minecraft, then "mcmcp status")',
    });
  } else {
    const token = (() => {
      try {
        return ensureToken(cfgToken);
      } catch {
        return '';
      }
    })();
    const results = await Promise.all(
      descriptors.map(async (descriptor) => {
        const client = new ModClient({ host: descriptor.host ?? '127.0.0.1', port: descriptor.port, token });
        try {
          const health = await client.health(2000);
          return { descriptor, health, error: null as string | null };
        } catch (err) {
          return { descriptor, health: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    for (const result of results) {
      const where = `${result.descriptor.host ?? '127.0.0.1'}:${result.descriptor.port} (pid ${result.descriptor.pid})`;
      if (result.health) {
        checks.push({
          status: 'PASS',
          label: 'client',
          detail: `${where} MC ${result.health.mc}, mod ${result.health.version}, player ${result.health.player ?? 'none'}, up ${formatDuration(result.health.uptimeMs)}`,
        });
      } else {
        checks.push({ status: 'WARN', label: 'client', detail: `${where} did not answer /health: ${result.error}` });
      }
    }
  }

  // Instances.
  const instances = listInstances();
  if (instances.length === 0) {
    checks.push({
      status: 'WARN',
      label: 'instances',
      detail: 'none found (looked in PrismLauncher native/Flatpak and ~/.minecraft)',
    });
  } else {
    const jars = findBuiltJars(opts.projectDir);
    const fabric = instances.filter((i) => i.fabric);
    const withMod = instances.filter((i) => i.hasMod);
    const missing: string[] = [];
    const stale: string[] = [];
    const noBuild: string[] = [];
    for (const instance of fabric) {
      const jar = jarForInstance(jars, instance.mcVersion ?? null);
      if (!jar) {
        noBuild.push(`${instance.id} ${instance.mcVersion ?? '?'}`);
        continue;
      }
      if (!instance.hasMod) missing.push(instance.id);
      else if (instance.modVersion && !path.basename(jar).includes(instance.modVersion)) stale.push(instance.id);
    }
    const bad = instances.filter((i) => !i.fabric);
    const detail = [
      `${instances.length} found, ${fabric.length} Fabric, ${withMod.length} with mcmcp, ${jars.length} jar(s) built`,
      missing.length ? `missing in: ${missing.join(', ')}` : '',
      stale.length ? `older build installed: ${stale.join(', ')}` : '',
      noBuild.length ? `no jar built for: ${noBuild.join(', ')}` : '',
      bad.length ? `not Fabric: ${bad.map((i) => `${i.id} (${i.loader})`).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const ok = missing.length === 0 && stale.length === 0 && noBuild.length === 0;
    checks.push({ status: ok && withMod.length > 0 ? 'PASS' : 'WARN', label: 'instances', detail });
  }

  // Launcher (only relevant when Prism instances exist).
  if (instances.some((instance) => instance.launcher === 'prism')) {
    const prism = findPrismBinary();
    checks.push(
      prism
        ? { status: 'PASS', label: 'launcher', detail: `prism ${prism}` }
        : {
            status: 'WARN',
            label: 'launcher',
            detail: 'PrismLauncher not found; "mcmcp launch" will not work (set MCMCP_PRISM)',
          },
    );
  }

  // Built jars.
  const builtJars = findBuiltJars(opts.projectDir);
  checks.push(
    builtJars.length > 0
      ? {
          status: 'PASS',
          label: 'mod jar',
          detail:
            builtJars.length === 1
              ? (builtJars[0] as string)
              : `${builtJars.length} builds: ${builtJars.map((jar) => path.basename(jar)).join(', ')}`,
        }
      : {
          status: 'WARN',
          label: 'mod jar',
          detail: 'no built jar found (cd mod && ./gradlew build, or set MCMCP_MOD_JAR)',
        },
  );

  // CLI on PATH.
  checks.push(
    isCommandOnPath('mcmcp')
      ? { status: 'PASS', label: 'mcmcp on PATH', detail: 'yes' }
      : {
          status: 'WARN',
          label: 'mcmcp on PATH',
          detail: 'not found; OpenCode will fail to start the server. Run "npm link" in server/.',
        },
  );

  // OpenCode wiring.
  const opencodeEntries = opencodeStatus({ projectDir: opts.projectDir });
  const globalConfigured = opencodeEntries.some((entry) => entry.scope === 'global' && entry.configured);
  for (const entry of opencodeEntries) {
    const label = `opencode ${entry.scope}`;
    if (!entry.exists) {
      checks.push(
        globalConfigured && entry.scope === 'project'
          ? { status: 'PASS', label, detail: 'no project config; the global entry covers every project' }
          : { status: 'WARN', label, detail: `no config at ${entry.path}` },
      );
    } else if (!entry.configured) {
      checks.push({
        status: 'WARN',
        label,
        detail: `${entry.path} has no "${'minecraft'}" server (run "mcmcp setup-opencode${entry.scope === 'global' ? ' --global' : ''}")`,
      });
    } else {
      const command = entry.command ?? SERVER_COMMAND;
      checks.push({
        status: command[0] === 'mcmcp' && !isCommandOnPath('mcmcp') ? 'WARN' : 'PASS',
        label,
        detail: `${entry.path} (${entry.shape}) → ${command.join(' ')}`,
      });
    }
  }

  // Port.
  checks.push(await checkPort(port));

  // Give the event loop a tick so a stray connection cannot keep us alive.
  await sleep(0);

  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;
  return {
    checks,
    failed,
    warned,
    exitCode: failed > 0 ? 1 : 0,
    lines: () => checks.map(line),
  };
}

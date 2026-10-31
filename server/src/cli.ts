#!/usr/bin/env node
/**
 * `mcmcp` command line: a thin, dependency-free shell over the same code the MCP
 * server uses. Human output is compact tables/lines; `--json` prints the raw
 * payload. Exit codes: 0 ok, 1 error (`mcmcp: <message>` on stderr).
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addressOf,
  clientsDir,
  configDir,
  configPath,
  defaultTokenPath,
  ensureToken,
  loadConfig,
  readDescriptors,
  resolveClient,
  saveConfig,
  tokenPermissions,
  type McmcpConfig,
} from './config.js';
import { runDoctor } from './doctor.js';
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
import { serveStdio } from './mcp.js';
import { setup as setupOpencode, status as opencodeStatus } from './opencode.js';
import { McmcpError, type HealthInfo } from './protocol.js';
import { toolSummary } from './tools.js';
import { formatDuration, pathExists } from './util.js';
import { VERSION } from './mcp.js';

const BOOLEAN_FLAGS = new Set(['json', 'all', 'global', 'v1', 'no-wait', 'help', 'yes', 'wait', 'quiet']);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** `--flag value`, `--flag=value`, `-h`; everything else is positional. */
export function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('-')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function flagBool(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags[name];
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function flagNumber(parsed: ParsedArgs, name: string): number | undefined {
  const raw = flagString(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new McmcpError(-32602, `--${name} must be a number, got "${raw}"`);
  return value;
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function instanceLine(instance: Instance): string {
  const loader = instance.loaderVersion ? `${instance.loader} ${instance.loaderVersion}` : instance.loader;
  const mod = instance.hasMod ? `mcmcp ${instance.modVersion ?? '?'}` : '-';
  return `${instance.id}\t${instance.mcVersion ?? '?'}\t${loader}\t${mod}\t${instance.launcher}\t${instance.name}`;
}

function instanceTable(instances: Instance[]): string {
  const rows = [
    ['id', 'MC', 'loader', 'mod', 'launcher', 'name'],
    ...instances.map((i) => [
      i.id,
      i.mcVersion ?? '?',
      i.loaderVersion ? `${i.loader} ${i.loaderVersion}` : i.loader,
      i.hasMod ? `mcmcp ${i.modVersion ?? '?'}` : '-',
      i.launcher,
      i.name,
    ]),
  ];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row, index) => {
      const line = row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ');
      if (index !== 0) return line;
      return `${line}\n${widths.map((w) => '-'.repeat(w)).join('  ')}`;
    })
    .join('\n');
}

function healthLine(health: HealthInfo, endpoint: string): string {
  return [
    `endpoint   ${endpoint}`,
    `mod        ${health.name} ${health.version} (MC ${health.mc})`,
    `player     ${health.player ?? 'none'}${health.inWorld ? '' : ' (menu)'}`,
    `uptime     ${formatDuration(health.uptimeMs)}`,
  ].join('\n');
}

async function readParams(raw: string | undefined): Promise<Record<string, unknown>> {
  if (!raw) return {};
  let text = raw;
  if (raw.startsWith('@')) {
    const file = raw.slice(1);
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new McmcpError(-32602, `cannot read params file ${file}: ${(err as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new McmcpError(-32602, `params must be JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McmcpError(-32602, 'params must be a JSON object, e.g. \'{"after":0}\'');
  }
  return parsed as Record<string, unknown>;
}

const USAGE = `mcmcp ${VERSION} - MCP server and CLI for a live Minecraft Java client

Usage: mcmcp <command> [options]

Commands:
  serve                              run the MCP server on stdio (for OpenCode)
  status                             game status through the running client
  health                             cheap liveness check of the client
  call <method> [json|@file]         call any mod method (JSON params)
  methods                            list the mod's method catalog
  tools                              list the MCP tools
  instances                          list local Minecraft instances
  install [--instance <id>|--all] [--jar <path>]
  uninstall --instance <id>|--all
  launch <instance> [--no-wait] [--timeoutMs <n>]
  logs [--instance <id>] [--lines <n>]
  config [show|path|init]
  doctor                             check the whole setup
  setup-opencode [--global|--project <dir>] [--v1]
  completion <bash|zsh>

Global options:
  --json        print raw JSON instead of a human summary
  -h, --help    show this help

Environment:
  MCMCP_URL     full base URL, e.g. http://127.0.0.1:25585
  MCMCP_HOST / MCMCP_PORT   address when no client descriptor is found
  MCMCP_TOKEN   bearer token (overrides the token file)
  MCMCP_MOD_JAR jar to install when --jar is omitted`;

async function cmdStatus(parsed: ParsedArgs): Promise<number> {
  const resolved = await resolveClient();
  const status = await resolved.client.call<Record<string, unknown>>('status');
  if (flagBool(parsed, 'json')) {
    printJson({ endpoint: addressOf(resolved), health: resolved.info, status });
    return 0;
  }
  const player = status.player;
  const playerName =
    typeof player === 'object' && player !== null && typeof (player as Record<string, unknown>).name === 'string'
      ? String((player as Record<string, unknown>).name)
      : null;
  const screen = status.screen;
  const screenTitle =
    typeof screen === 'object' && screen !== null ? String((screen as Record<string, unknown>).title ?? 'none') : 'none';
  out(
    [
      `endpoint   ${addressOf(resolved)}`,
      `mod        ${String(status.modVersion ?? '?')} (MC ${String(status.mcVersion ?? resolved.info.mc)})`,
      `loader     ${String(status.loaderVersion ?? '?')} (Fabric API ${String(status.fabricApiVersion ?? '?')})`,
      `player     ${playerName ?? 'not in world'}${status.inWorld === false ? ' (menu)' : ''}`,
      `screen     ${screenTitle}`,
      `fps        ${String(status.fps ?? '?')}   ping ${String(status.ping ?? '?')} ms`,
      `uptime     ${formatDuration(Number(status.uptimeMs ?? resolved.info.uptimeMs ?? 0))}`,
    ].join('\n'),
  );
  return 0;
}

async function cmdHealth(parsed: ParsedArgs): Promise<number> {
  const resolved = await resolveClient();
  if (flagBool(parsed, 'json')) {
    printJson({ endpoint: addressOf(resolved), health: resolved.info });
    return 0;
  }
  out(healthLine(resolved.info, addressOf(resolved)));
  return 0;
}

async function cmdCall(parsed: ParsedArgs): Promise<number> {
  const method = parsed.positionals[1];
  if (!method) throw new McmcpError(-32602, 'usage: mcmcp call <method> [json|@file]');
  const params = await readParams(parsed.positionals[2] ?? flagString(parsed, 'params'));
  const resolved = await resolveClient();
  const result = await resolved.client.call(method, params);
  if (flagBool(parsed, 'json')) {
    printJson(result);
  } else {
    out(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }
  return 0;
}

async function cmdMethods(parsed: ParsedArgs): Promise<number> {
  const resolved = await resolveClient();
  const methods = await resolved.client.methods();
  if (flagBool(parsed, 'json')) {
    printJson(methods);
    return 0;
  }
  for (const method of methods) {
    out(`${method.name.padEnd(24)} ${method.summary ?? ''}`);
  }
  return 0;
}

function cmdTools(parsed: ParsedArgs): number {
  const tools = toolSummary();
  if (flagBool(parsed, 'json')) {
    printJson(tools);
    return 0;
  }
  for (const tool of tools) {
    out(`${tool.name.padEnd(14)} ${tool.description.split('\n')[0] ?? ''}`);
  }
  return 0;
}

function cmdInstances(parsed: ParsedArgs): number {
  const instances = listInstances();
  if (flagBool(parsed, 'json')) {
    printJson(instances);
    return 0;
  }
  if (instances.length === 0) {
    out('No Minecraft instances found (PrismLauncher native/Flatpak, ~/.minecraft).');
    return 0;
  }
  out(instanceTable(instances));
  return 0;
}

function cmdInstall(parsed: ParsedArgs): number {
  const all = flagBool(parsed, 'all');
  const instanceId = flagString(parsed, 'instance');
  if (!all && !instanceId) {
    throw new McmcpError(-32602, 'usage: mcmcp install --instance <id> | --all  [--jar <path>]');
  }
  const jar = flagString(parsed, 'jar') ?? findBuiltJar();
  if (!jar) {
    throw new McmcpError(-32000, 'no built mod jar found. Build it (cd mod && ./gradlew build), pass --jar, or set MCMCP_MOD_JAR.');
  }
  const instances = listInstances();
  const targets = all ? instances : [findInstance(instanceId ?? '')];
  const outcomes = installMod(targets, jar, { strict: !all, force: flagBool(parsed, 'force') });
  if (flagBool(parsed, 'json')) {
    printJson({ jar, outcomes });
    return 0;
  }
  out(`jar: ${jar}`);
  let installed = 0;
  for (const outcome of outcomes) {
    if (outcome.action === 'skipped') {
      out(`skipped   ${outcome.instance.id}: ${outcome.reason ?? 'not Fabric'}`);
      continue;
    }
    installed += 1;
    const removed = outcome.removed.length ? ` (removed ${outcome.removed.join(', ')})` : '';
    out(`installed ${outcome.instance.id}: ${outcome.path ?? ''}${removed}`);
  }
  if (installed === 0) err('mcmcp: nothing was installed.');
  return installed === 0 ? 1 : 0;
}

function cmdUninstall(parsed: ParsedArgs): number {
  const all = flagBool(parsed, 'all');
  const instanceId = flagString(parsed, 'instance');
  if (!all && !instanceId) {
    throw new McmcpError(-32602, 'usage: mcmcp uninstall --instance <id> | --all');
  }
  const instances = listInstances();
  const targets = all ? instances : [findInstance(instanceId ?? '')];
  const outcomes = targets.map((instance) => uninstallMod(instance));
  if (flagBool(parsed, 'json')) {
    printJson(outcomes);
    return 0;
  }
  for (const outcome of outcomes) {
    out(
      `${outcome.instance.id.padEnd(22)} ${outcome.removed.length ? `removed ${outcome.removed.join(', ')}` : 'nothing to remove'}`,
    );
  }
  return 0;
}

async function cmdLaunch(parsed: ParsedArgs): Promise<number> {
  const id = parsed.positionals[1];
  if (!id) throw new McmcpError(-32602, 'usage: mcmcp launch <instance> [--no-wait] [--timeoutMs <n>]');
  const wait = !flagBool(parsed, 'no-wait') && !flagBool(parsed, 'noWait');
  const result = await launchInstance(id, { wait, timeoutMs: flagNumber(parsed, 'timeoutMs') });
  if (flagBool(parsed, 'json')) {
    printJson({
      instance: result.instance,
      via: result.via,
      command: result.command,
      pid: result.pid,
      endpoint: result.client?.client.address ?? null,
      health: result.client?.info ?? null,
    });
    return 0;
  }
  out(`launched ${result.instance.id} via ${result.via}`);
  out(`command: ${result.command.join(' ')}`);
  if (result.client) {
    out(`endpoint: ${result.client.client.address}`);
    out(healthLine(result.client.info, result.client.client.address));
  } else {
    out('not waiting for the client (--no-wait). Check "mcmcp status" in a moment.');
  }
  return 0;
}

function cmdLogs(parsed: ParsedArgs): number {
  const instanceId = flagString(parsed, 'instance');
  const lines = flagNumber(parsed, 'lines') ?? 200;
  const instances = listInstances();
  const instance = instanceId
    ? findInstance(instanceId)
    : instances.length === 1
      ? (instances[0] as Instance)
      : (() => {
          throw new McmcpError(
            -32602,
            instances.length === 0
              ? 'no Minecraft instances found'
              : `several instances found; pass --instance (${instances.map((i) => i.id).join(', ')})`,
          );
        })();
  const tail = readInstanceLog(instance, lines);
  if (flagBool(parsed, 'json')) {
    printJson({ instance: instance.id, path: tail.path, lines: tail.lines });
    return 0;
  }
  out(`# ${tail.path}`);
  for (const text of tail.lines) out(text);
  return 0;
}

function cmdConfig(parsed: ParsedArgs): number {
  const sub = parsed.positionals[1] ?? 'show';

  if (sub === 'path') {
    if (flagBool(parsed, 'json')) {
      printJson({ configDir: configDir(), config: configPath(), token: defaultTokenPath(), clients: clientsDir() });
    } else {
      out(configDir());
    }
    return 0;
  }

  if (sub === 'init') {
    const cfg = (() => {
      try {
        return loadConfig();
      } catch {
        return {
          host: '127.0.0.1',
          port: 25585,
          tokenFile: defaultTokenPath(),
          allowRemote: false,
        } satisfies McmcpConfig;
      }
    })();
    const existed = pathExists(configPath());
    const written = existed ? configPath() : saveConfig(cfg);
    const token = ensureToken(cfg.tokenFile);
    if (flagBool(parsed, 'json')) {
      printJson({ ...cfg, config: written, created: !existed, token: { path: cfg.tokenFile, exists: token.length > 0 } });
      return 0;
    }
    out(`${existed ? 'kept ' : 'wrote'}    ${written}`);
    out(`token    ${cfg.tokenFile} (${tokenPermissions(cfg.tokenFile).mode ?? '?'})`);
    return 0;
  }

  if (sub !== 'show') throw new McmcpError(-32602, `unknown config subcommand "${sub}" (expected show|path|init)`);

  const cfg = loadConfig();
  const tokenPath = cfg.tokenFile;
  const perms = tokenPermissions(tokenPath);
  if (flagBool(parsed, 'json')) {
    printJson({
      ...cfg,
      configPath: configPath(),
      token: { path: tokenPath, exists: perms.exists, mode: perms.mode },
      clientsDir: clientsDir(),
      clients: readDescriptors(),
    });
    return 0;
  }
  out(`config   ${configPath()}${pathExists(configPath()) ? '' : ' (defaults, file not written)'}`);
  out(`dir      ${configDir()}`);
  out(`host     ${cfg.host}`);
  out(`port     ${cfg.port}`);
  out(`token    ${tokenPath}${perms.exists ? ` (mode ${perms.mode})` : ' (missing)'}`);
  out(`remote   ${cfg.allowRemote ? 'allowed' : 'loopback only'}`);
  out(`clients  ${readDescriptors().length} running descriptor(s) in ${clientsDir()}`);
  return 0;
}

async function cmdDoctor(parsed: ParsedArgs): Promise<number> {
  const report = await runDoctor({});
  if (flagBool(parsed, 'json')) {
    printJson({ checks: report.checks, failed: report.failed, warned: report.warned });
  } else {
    for (const check of report.checks) out(`${check.status.padEnd(5)} ${check.label.padEnd(22)} ${check.detail}`);
    out();
    out(`${report.failed} failed, ${report.warned} warning(s)`);
  }
  return report.exitCode;
}

function cmdSetupOpencode(parsed: ParsedArgs): number {
  const global = flagBool(parsed, 'global');
  const projectFlag = parsed.flags.project;
  const projectDir =
    typeof projectFlag === 'string' ? projectFlag : projectFlag === true ? process.cwd() : global ? undefined : process.cwd();

  const result = setupOpencode({ global, projectDir: global ? undefined : projectDir, v1: flagBool(parsed, 'v1') });
  if (flagBool(parsed, 'json')) {
    printJson(result);
    return 0;
  }
  out(`${result.changed ? (result.created ? 'created' : 'updated') : 'unchanged'}  ${result.path} (${result.shape})`);
  out(`server   minecraft → ${result.command.join(' ')}`);
  if (result.backup) out(`backup   ${result.backup}`);
  if (result.commandMissing) {
    err('mcmcp: warning: "mcmcp" is not on PATH; run "npm link" in server/ so OpenCode can start it.');
  }

  const statuses = opencodeStatus({ projectDir: global ? process.cwd() : projectDir });
  for (const entry of statuses) {
    if (!entry.exists || !entry.configured) continue;
    out(`verified ${entry.scope}: ${entry.path}`);
  }
  return 0;
}

function cmdCompletion(parsed: ParsedArgs): number {
  const shell = parsed.positionals[1] ?? 'bash';
  const commands = [
    'serve',
    'status',
    'health',
    'call',
    'methods',
    'tools',
    'instances',
    'install',
    'uninstall',
    'launch',
    'logs',
    'config',
    'doctor',
    'setup-opencode',
    'completion',
  ];

  if (shell === 'bash') {
    out(`# mcmcp bash completion
_mcmcp() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${commands.join(' ')}" -- "\$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
    completion) COMPREPLY=( \$(compgen -W "bash zsh" -- "\$cur") ) ;;
    config) COMPREPLY=( \$(compgen -W "show path init" -- "\$cur") ) ;;
    install|uninstall|logs|launch) COMPREPLY=( \$(compgen -f -- "\$cur") ) ;;
    *) COMPREPLY=( \$(compgen -W "--json --help" -- "\$cur") ) ;;
  esac
}
complete -F _mcmcp mcmcp`);
    return 0;
  }
  if (shell === 'zsh') {
    out(`#compdef mcmcp
# mcmcp zsh completion
_mcmcp() {
  local -a commands
  commands=(
${commands.map((command) => `    '${command}'`).join('\n')}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
    completion) _values 'shell' bash zsh ;;
    config) _values 'subcommand' show path init ;;
    *) _files ;;
  esac
}
compdef _mcmcp mcmcp`);
    return 0;
  }
  throw new McmcpError(-32602, `unknown shell "${shell}" (expected bash or zsh)`);
}

/** Run one command. Returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const command = parsed.positionals[0];

  if (!command || command === 'help' || flagBool(parsed, 'help')) {
    out(USAGE);
    return 0;
  }

  switch (command) {
    case 'serve':
      await serveStdio();
      return 0;
    case 'status':
      return cmdStatus(parsed);
    case 'health':
      return cmdHealth(parsed);
    case 'call':
      return cmdCall(parsed);
    case 'methods':
      return cmdMethods(parsed);
    case 'tools':
      return cmdTools(parsed);
    case 'instances':
      return cmdInstances(parsed);
    case 'install':
      return cmdInstall(parsed);
    case 'uninstall':
      return cmdUninstall(parsed);
    case 'launch':
      return cmdLaunch(parsed);
    case 'logs':
      return cmdLogs(parsed);
    case 'config':
      return cmdConfig(parsed);
    case 'doctor':
      return cmdDoctor(parsed);
    case 'setup-opencode':
      return cmdSetupOpencode(parsed);
    case 'completion':
      return cmdCompletion(parsed);
    case 'version':
    case '--version':
      out(VERSION);
      return 0;
    default:
      err(`mcmcp: unknown command "${command}"`);
      out(USAGE);
      return 1;
  }
}

async function main(): Promise<void> {
  // `mcmcp tools | head` must not crash with EPIPE.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  const argv = process.argv.slice(2);
  try {
    const code = await run(argv);
    process.exitCode = code;
  } catch (error) {
    const message =
      error instanceof McmcpError
        ? `${error.message}${error.code === -32000 ? '' : ` (code ${error.code})`}`
        : error instanceof Error
          ? error.message
          : String(error);
    err(`mcmcp: ${message}`);
    process.exitCode = 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (invokedDirectly()) {
  void main();
}

export { main };

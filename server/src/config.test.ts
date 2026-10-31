import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  clientsDir,
  configDir,
  configPath,
  defaultTokenPath,
  ensureToken,
  loadConfig,
  readDescriptors,
  resolveClient,
  resolveToken,
  saveConfig,
} from './config.js';
import { McmcpError } from './protocol.js';
import { deadPid, startFakeMod, type FakeMod } from './testutil.js';

describe('config, token and discovery', () => {
  let root: string;
  let originalXdg: string | undefined;
  let originalUrl: string | undefined;
  let originalPort: string | undefined;
  let originalHost: string | undefined;
  let originalToken: string | undefined;
  const mods: FakeMod[] = [];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mcmcp-config-'));
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalUrl = process.env.MCMCP_URL;
    originalPort = process.env.MCMCP_PORT;
    originalHost = process.env.MCMCP_HOST;
    originalToken = process.env.MCMCP_TOKEN;
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.MCMCP_URL;
    delete process.env.MCMCP_PORT;
    delete process.env.MCMCP_HOST;
    delete process.env.MCMCP_TOKEN;
  });

  afterEach(async () => {
    for (const mod of mods.splice(0)) await mod.close();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalUrl === undefined) delete process.env.MCMCP_URL;
    else process.env.MCMCP_URL = originalUrl;
    if (originalPort === undefined) delete process.env.MCMCP_PORT;
    else process.env.MCMCP_PORT = originalPort;
    if (originalHost === undefined) delete process.env.MCMCP_HOST;
    else process.env.MCMCP_HOST = originalHost;
    if (originalToken === undefined) delete process.env.MCMCP_TOKEN;
    else process.env.MCMCP_TOKEN = originalToken;
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the config dir under XDG_CONFIG_HOME', () => {
    assert.equal(configDir(), path.join(root, 'mcmcp'));
    assert.equal(configPath(), path.join(root, 'mcmcp', 'config.json'));
    assert.equal(clientsDir(), path.join(root, 'mcmcp', 'clients'));
  });

  it('defaults to loopback port 25585', () => {
    const cfg = loadConfig();
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 25585);
    assert.equal(cfg.allowRemote, false);
    assert.equal(cfg.tokenFile, defaultTokenPath());
  });

  it('round-trips config.json and keeps overlapping fields', () => {
    mkdirSync(configDir(), { recursive: true });
    const file = saveConfig({ host: '127.0.0.1', port: 26000, tokenFile: '~/elsewhere/token', allowRemote: true });
    assert.equal(file, configPath());
    const loaded = loadConfig();
    assert.equal(loaded.port, 26000);
    assert.equal(loaded.allowRemote, true);
    assert.equal(loaded.tokenFile, path.join(process.env.HOME ?? '', 'elsewhere', 'token'));
    assert.match(readFileSync(file, 'utf8'), /\n$/);
  });

  it('rejects a malformed config with an actionable error', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), '{ nope');
    assert.throws(
      () => loadConfig(),
      (err: unknown) => err instanceof McmcpError && /mcmcp config init/.test(err.message),
    );
  });

  it('creates a 32-byte hex token with mode 0600 and never overwrites it', () => {
    const token = ensureToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    const file = defaultTokenPath();
    assert.equal(readFileSync(file, 'utf8').trim(), token);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    writeFileSync(file, 'keep-me\n');
    assert.equal(ensureToken(), 'keep-me');
    assert.equal(readFileSync(file, 'utf8'), 'keep-me\n');
  });

  it('honours token precedence: explicit > env > tokenFile', () => {
    const cfg = loadConfig();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(cfg.tokenFile, 'from-file\n');
    assert.equal(resolveToken(), 'from-file');
    process.env.MCMCP_TOKEN = 'from-env';
    assert.equal(resolveToken(), 'from-env');
    assert.equal(resolveToken('from-option'), 'from-option');
  });

  it('reads live descriptors and prunes stale ones', () => {
    mkdirSync(clientsDir(), { recursive: true });
    writeFileSync(
      path.join(clientsDir(), `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, port: 25999, mcVersion: '1.21.4', modVersion: '1.0.0', player: 'Steve', startedAt: 10 }),
    );
    const staleFile = path.join(clientsDir(), `${deadPid()}.json`);
    writeFileSync(
      staleFile,
      JSON.stringify({ pid: deadPid(), port: 25998, mcVersion: '1.21.4', modVersion: '1.0.0', player: null, startedAt: 20 }),
    );
    writeFileSync(path.join(clientsDir(), 'broken.json'), '{ not json');

    const live = readDescriptors();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.pid, process.pid);
    assert.equal(live[0]?.port, 25999);
    assert.equal(readDescriptors().length, 1);
    assert.throws(() => statSync(staleFile));
  });

  it('discovers the newest healthy client by descriptor', async () => {
    const older = await startFakeMod({ token: 'secret', health: { mc: '1.20.1', player: 'Alex' } });
    const newer = await startFakeMod({ token: 'secret', health: { mc: '1.21.4', player: 'Steve' } });
    mods.push(older, newer);
    mkdirSync(clientsDir(), { recursive: true });
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(defaultTokenPath(), 'secret\n');
    writeFileSync(
      path.join(clientsDir(), '1.json'),
      JSON.stringify({ pid: process.pid, port: older.port, mcVersion: '1.20.1', modVersion: '1.0.0', player: 'Alex', startedAt: 1 }),
    );
    writeFileSync(
      path.join(clientsDir(), '2.json'),
      JSON.stringify({ pid: process.pid, port: newer.port, mcVersion: '1.21.4', modVersion: '1.0.0', player: 'Steve', startedAt: 2 }),
    );

    const resolved = await resolveClient();
    assert.equal(resolved.source, 'discovery');
    assert.equal(resolved.info.mc, '1.21.4');
    assert.equal(resolved.client.port, newer.port);
    assert.equal(resolved.client.token, 'secret');
  });

  it('lets MCMCP_URL win over explicit and discovery', async () => {
    const direct = await startFakeMod({ token: 'secret', health: { mc: '1.19.2' } });
    const other = await startFakeMod({ token: 'secret', health: { mc: '1.20.4' } });
    mods.push(direct, other);
    process.env.MCMCP_URL = direct.url;
    mkdirSync(clientsDir(), { recursive: true });
    writeFileSync(defaultTokenPath(), 'secret\n');
    writeFileSync(
      path.join(clientsDir(), '1.json'),
      JSON.stringify({ pid: process.pid, port: other.port, startedAt: 5, mcVersion: '1.20.4', modVersion: '1', player: null }),
    );

    const resolved = await resolveClient({ port: other.port });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.info.mc, '1.19.2');
    assert.equal(resolved.client.address, direct.url);
  });

  it('honours MCMCP_PORT and MCMCP_HOST', async () => {
    const mod = await startFakeMod({ token: 'secret', health: { mc: '1.18.2' } });
    mods.push(mod);
    process.env.MCMCP_PORT = String(mod.port);
    process.env.MCMCP_HOST = '127.0.0.1';
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path.join(configDir(), 'token'), 'secret\n');
    const resolved = await resolveClient();
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.info.mc, '1.18.2');
  });

  it('throws a helpful error when nothing is running', async () => {
    await assert.rejects(
      () => resolveClient(),
      (err: unknown) => {
        assert.ok(err instanceof McmcpError);
        assert.equal(err.code, -32000);
        assert.match(err.message, /no Minecraft client found/);
        assert.match(err.message, /mcmcp instances/);
        assert.match(err.message, /mcmcp launch/);
        return true;
      },
    );
  });

  it('reports descriptors that do not answer health', async () => {
    mkdirSync(clientsDir(), { recursive: true });
    writeFileSync(
      path.join(clientsDir(), '1.json'),
      JSON.stringify({ pid: process.pid, port: 1, startedAt: 1, mcVersion: '1', modVersion: '1', player: null }),
    );
    await assert.rejects(
      () => resolveClient(),
      (err: unknown) => err instanceof McmcpError && /none answered \/health/.test(err.message),
    );
  });
});

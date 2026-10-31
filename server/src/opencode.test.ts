import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { detectShape, parseJsonc, resolveConfigPath, setup, status } from './opencode.js';
import { McmcpError } from './protocol.js';

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('opencode setup', () => {
  let root: string;
  let project: string;
  let globalDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mcmcp-opencode-'));
    project = path.join(root, 'project');
    globalDir = path.join(root, 'opencode');
    mkdirSync(project, { recursive: true });

    // Pretend `mcmcp` is installed so setup() does not print its PATH warning.
    const binDir = path.join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, 'mcmcp');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a v2 project config from scratch', () => {
    const result = setup({ projectDir: project });
    assert.equal(result.created, true);
    assert.equal(result.shape, 'v2');
    assert.equal(result.path, path.join(project, 'opencode.json'));

    const config = readJson(result.path);
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    const mcp = config.mcp as Record<string, unknown>;
    const servers = mcp.servers as Record<string, unknown>;
    assert.deepEqual(servers.minecraft, { type: 'local', command: ['mcmcp', 'serve'], enabled: true });
  });

  it('writes v1 when asked, with mcp.minecraft directly', () => {
    const result = setup({ projectDir: project, v1: true });
    assert.equal(result.shape, 'v1');
    const config = readJson(result.path);
    assert.equal(config.$schema, undefined);
    const mcp = config.mcp as Record<string, unknown>;
    assert.deepEqual(mcp.minecraft, { type: 'local', command: ['mcmcp', 'serve'], enabled: true });
    assert.equal(mcp.servers, undefined);
  });

  it('detects v1 and keeps existing servers', () => {
    const file = path.join(project, 'opencode.json');
    writeFileSync(
      file,
      JSON.stringify({ mcp: { other: { type: 'remote', url: 'http://example.test/mcp' } }, model: 'x/y' }),
    );
    const result = setup({ projectDir: project });
    assert.equal(result.shape, 'v1');
    const config = readJson(file);
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    assert.deepEqual(mcp.other, { type: 'remote', url: 'http://example.test/mcp' });
    assert.deepEqual(mcp.minecraft, { type: 'local', command: ['mcmcp', 'serve'], enabled: true });
    assert.equal(config.model, 'x/y');
  });

  it('detects v2 and keeps other keys and servers', () => {
    const file = path.join(project, 'opencode.json');
    writeFileSync(
      file,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        theme: 'dark',
        mcp: { servers: { shell: { type: 'local', command: ['bash'] } } },
      }),
    );
    const result = setup({ projectDir: project });
    assert.equal(result.shape, 'v2');
    const config = readJson(file);
    assert.equal(config.theme, 'dark');
    const servers = (config.mcp as Record<string, Record<string, unknown>>).servers;
    assert.ok(servers);
    assert.deepEqual(servers?.shell, { type: 'local', command: ['bash'] });
    assert.deepEqual(servers?.minecraft, { type: 'local', command: ['mcmcp', 'serve'], enabled: true });
  });

  it('is idempotent: a second run changes nothing', () => {
    const first = setup({ projectDir: project });
    assert.equal(first.changed, true);
    const before = readFileSync(first.path, 'utf8');

    const second = setup({ projectDir: project });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    assert.equal(readFileSync(first.path, 'utf8'), before);
  });

  it('strips comments and trailing commas before merging', () => {
    const file = path.join(project, 'opencode.json');
    writeFileSync(
      file,
      `{
  // keep this list tidy
  "$schema": "https://opencode.ai/config.json",
  /* other servers */
  "mcp": {
    "servers": {
      "shell": { "type": "local", "command": ["bash"], },
    },
  },
}`,
    );
    const result = setup({ projectDir: project });
    assert.equal(result.shape, 'v2');
    const config = readJson(file); // must now be strict JSON
    const servers = (config.mcp as Record<string, Record<string, unknown>>).servers;
    assert.ok(servers?.shell);
    assert.ok(servers?.minecraft);
  });

  it('backs up an existing file before writing', () => {
    const file = path.join(project, 'opencode.json');
    const original = '{\n  "model": "keep/me"\n}\n';
    writeFileSync(file, original);
    const result = setup({ projectDir: project });
    assert.equal(result.backup, `${file}.bak`);
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), original);
    const config = readJson(file);
    assert.equal(config.model, 'keep/me');
  });

  it('writes the global config in the given dir and reports status', () => {
    const result = setup({ global: true, globalDir });
    assert.equal(result.path, path.join(globalDir, 'opencode.json'));

    const entries = status({ globalDir, projectDir: project });
    const global = entries.find((entry) => entry.scope === 'global');
    assert.ok(global);
    assert.equal(global.configured, true);
    assert.equal(global.shape, 'v2');
    assert.deepEqual(global.command, ['mcmcp', 'serve']);

    const projectEntry = entries.find((entry) => entry.scope === 'project');
    assert.ok(projectEntry);
    assert.equal(projectEntry.configured, false);
  });

  it('prefers an existing opencode.jsonc', () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'opencode.jsonc'), '{}\n');
    assert.equal(resolveConfigPath(globalDir), path.join(globalDir, 'opencode.jsonc'));
  });

  it('parses jsonc values', () => {
    const value = parseJsonc('{\n // comment\n "a": 1, /* block */\n "b": ["x",],\n}');
    assert.deepEqual(value, { a: 1, b: ['x'] });
    assert.deepEqual(parseJsonc(''), {});
    assert.deepEqual(parseJsonc('{"url":"http://x//y"}'), { url: 'http://x//y' });
  });

  it('detects shapes', () => {
    assert.equal(detectShape({}), 'none');
    assert.equal(detectShape({ mcp: { servers: {} } }), 'v2');
    assert.equal(detectShape({ mcp: { minecraft: { type: 'local' } } }), 'v1');
  });

  it('reports unreadable configs instead of throwing away data', () => {
    const file = path.join(project, 'opencode.json');
    writeFileSync(file, '{ nope');
    assert.throws(() => setup({ projectDir: project }), (err: unknown) => err instanceof McmcpError);
  });
});

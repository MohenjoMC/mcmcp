import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './mcp.js';
import { TOOL_DEFS, resetClientCache } from './tools.js';
import { startFakeMod, type FakeMod } from './testutil.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('MCP server over an in-memory transport', () => {
  let mod: FakeMod;
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let tmp: string;
  let originalUrl: string | undefined;
  let originalToken: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mcmcp-mcp-'));
    mod = await startFakeMod({
      token: 'secret',
      handlers: {
        status: () => ({
          modVersion: '1.0.0',
          mcVersion: '1.21.4',
          loaderVersion: '0.16.9',
          fabricApiVersion: '0.110.0',
          player: { name: 'Steve', uuid: 'uuid' },
          inWorld: true,
          screen: { id: 0, title: 'Inventory' },
          fps: 120,
          ping: 12,
          uptimeMs: 5000,
        }),
        'gui.screen': () => ({
          id: 0,
          title: 'Inventory',
          widgets: [
            { id: 0, type: 'button', label: 'Done', x: 10, y: 20, width: 60, height: 20, active: true, visible: true },
          ],
        }),
        'gui.click': (params) => ({ clicked: { id: 0, label: 'Done', x: 10, y: 20, ...params } }),
        'player.state': () => ({
          name: 'Steve',
          position: { x: 1, y: 64, z: 2 },
          health: 20,
          maxHealth: 20,
          food: 18,
          xp: { level: 3 },
          yaw: 90,
          pitch: 0,
          onGround: true,
          sprinting: false,
          sneaking: false,
          flying: false,
          ping: 12,
          selectedSlot: 0,
          gameMode: 'survival',
          dimension: 'minecraft:overworld',
        }),
        'mod.ping': () => ({ pong: true, time: 1 }),
      },
      events: [{ seq: 3, time: 1, type: 'chat', data: { text: 'hello', kind: 'chat' } }],
    });

    originalUrl = process.env.MCMCP_URL;
    originalToken = process.env.MCMCP_TOKEN;
    process.env.MCMCP_URL = mod.url;
    process.env.MCMCP_TOKEN = 'secret';
    resetClientCache();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await mod.close();
    if (originalUrl === undefined) delete process.env.MCMCP_URL;
    else process.env.MCMCP_URL = originalUrl;
    if (originalToken === undefined) delete process.env.MCMCP_TOKEN;
    else process.env.MCMCP_TOKEN = originalToken;
    rmSync(tmp, { recursive: true, force: true });
  });

  function textOf(result: CallToolResult): string {
    const first = result.content[0];
    return first && first.type === 'text' ? first.text : '';
  }

  it('advertises exactly the documented tools', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, TOOL_DEFS.map((t) => t.name).sort());
    assert.equal(names.length, 15);
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('reports status with the endpoint and structured content', async () => {
    const result = (await client.callTool({ name: 'mc_status', arguments: {} })) as CallToolResult;
    assert.ok(!result.isError);
    const text = textOf(result);
    assert.match(text, new RegExp(mod.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /1\.21\.4/);

    const structured = result.structuredContent as Record<string, unknown> | undefined;
    assert.ok(structured);
    assert.equal(structured.endpoint, mod.url);
    const status = structured.status as Record<string, unknown>;
    assert.equal(status.modVersion, '1.0.0');
  });

  it('inspects the screen as a widget table and clicks by label', async () => {
    const inspected = (await client.callTool({ name: 'mc_screen', arguments: { action: 'inspect' } })) as CallToolResult;
    const text = textOf(inspected);
    assert.match(text, /widget\(s\)/);
    assert.match(text, /#0\s+button/);
    assert.match(text, /Done/);

    const clicked = (await client.callTool({
      name: 'mc_screen',
      arguments: { action: 'click', label: 'Do' },
    })) as CallToolResult;
    assert.ok(!clicked.isError);
    assert.deepEqual(mod.calls.at(-1)?.method, 'gui.click');
    assert.deepEqual(mod.calls.at(-1)?.params, { label: 'Do' });
  });

  it('maps player actions onto protocol methods', async () => {
    const state = (await client.callTool({ name: 'mc_player', arguments: { action: 'state' } })) as CallToolResult;
    assert.match(textOf(state), /Steve @ 1\.0, 64\.0, 2\.0/);

    await client.callTool({ name: 'mc_player', arguments: { action: 'select', slot: 3 } });
    assert.equal(mod.calls.at(-1)?.method, 'player.select');
    assert.deepEqual(mod.calls.at(-1)?.params, { slot: 3 });

    await client.callTool({ name: 'mc_player', arguments: { action: 'sneak', state: true } });
    assert.equal(mod.calls.at(-1)?.method, 'player.sneak');
    assert.deepEqual(mod.calls.at(-1)?.params, { state: true });
  });

  it('long-polls events and formats them', async () => {
    const result = (await client.callTool({
      name: 'mc_events',
      arguments: { after: 2, timeoutMs: 250, types: ['chat'] },
    })) as CallToolResult;
    assert.match(textOf(result), /#3\s+chat/);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.next, 1);
  });

  it('validates raw methods against the catalog and lists alternatives', async () => {
    const ok = (await client.callTool({ name: 'mc_raw', arguments: { method: 'mod.ping' } })) as CallToolResult;
    assert.ok(!ok.isError);
    assert.match(textOf(ok), /pong/);

    const bad = (await client.callTool({ name: 'mc_raw', arguments: { method: 'player.teleport' } })) as CallToolResult;
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /unknown method "player\.teleport"/);
    assert.match(textOf(bad), /player\.state/);
    assert.match(textOf(bad), /-32601/);
  });

  it('returns a compact error (no stack trace) when the client is unreachable', async () => {
    process.env.MCMCP_URL = 'http://127.0.0.1:1';
    resetClientCache();
    const result = (await client.callTool({ name: 'mc_status', arguments: {} })) as CallToolResult;
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /does not answer \/health/);
    assert.match(text, /-32000/);
    assert.doesNotMatch(text, /at .*\.js:\d+/);
  });

  it('works locally for mc_instances and mc_logs without a client', async () => {
    const instances = (await client.callTool({ name: 'mc_instances', arguments: {} })) as CallToolResult;
    assert.ok(!instances.isError);
    assert.ok(Array.isArray((instances.structuredContent as Record<string, unknown>).instances));

    const gameDir = path.join(tmp, 'vanilla');
    mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
    writeFileSync(path.join(gameDir, 'logs', 'latest.log'), 'one\ntwo\nthree\n');
    const logs = (await client.callTool({ name: 'mc_logs', arguments: { lines: 2 } })) as CallToolResult;
    // No instance matching "vanilla" on this machine -> a clear error, not a crash.
    if (logs.isError) assert.match(textOf(logs), /instance|instances/);
  });

  it('rejects invalid arguments at the schema boundary', async () => {
    const result = (await client.callTool({
      name: 'mc_screen',
      arguments: { action: 'teleport' },
    })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Invalid arguments|Input validation|invalid/i);
  });
});

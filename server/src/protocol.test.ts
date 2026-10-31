import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { McmcpError, ModClient } from './protocol.js';
import { startFakeMod, type FakeMod } from './testutil.js';

describe('ModClient against a fake mod server', () => {
  let mod: FakeMod;

  before(async () => {
    mod = await startFakeMod({
      token: 'secret',
      handlers: {
        'mod.ping': () => ({ pong: true, time: 1700000000000 }),
        'player.state': () => ({ name: 'Steve', health: 20 }),
        'gui.screen': () => ({ id: 0, title: 'Inventory', widgets: [] }),
        'gui.click': (params: Record<string, unknown>) => ({ clicked: params }),
      },
      events: [{ seq: 7, time: 1700000000000, type: 'chat', data: { text: 'hello', kind: 'chat' } }],
    });
  });

  after(async () => {
    await mod.close();
  });

  function client(overrides: { token?: string; timeoutMs?: number } = {}): ModClient {
    const url = new URL(mod.url);
    return new ModClient({
      baseUrl: mod.url,
      host: url.hostname,
      port: Number(url.port),
      token: overrides.token ?? 'secret',
      timeoutMs: overrides.timeoutMs,
    });
  }

  it('returns the JSON-RPC result and sends a well-formed request', async () => {
    const result = await client().call<{ pong: boolean }>('mod.ping');
    assert.equal(result.pong, true);

    const call = mod.calls.at(-1);
    assert.ok(call);
    assert.equal(call.method, 'mod.ping');
    assert.deepEqual(call.params, {});
    assert.equal(call.authorization, 'Bearer secret');
    assert.equal(typeof call.id, 'number');
  });

  it('passes params through', async () => {
    const result = await client().call<{ clicked: Record<string, unknown> }>('gui.click', { label: 'Done' });
    assert.deepEqual(result.clicked, { label: 'Done' });
    assert.deepEqual(mod.calls.at(-1)?.params, { label: 'Done' });
  });

  it('maps a JSON-RPC error to McmcpError with code and data', async () => {
    await assert.rejects(
      () => client().call('player.nope'),
      (err: unknown) => {
        assert.ok(err instanceof McmcpError);
        assert.equal(err.code, -32601);
        assert.match(err.message, /unknown method player\.nope/);
        assert.deepEqual(err.data, { method: 'player.nope' });
        return true;
      },
    );
  });

  it('maps a state error from a handler onto the same code', async () => {
    mod.setHandler('player.state', () => {
      throw Object.assign(new Error('no player'), { code: -32000, data: { method: 'player.state' } });
    });
    await assert.rejects(
      () => client().call('player.state'),
      (err: unknown) => {
        assert.ok(err instanceof McmcpError);
        assert.equal(err.code, -32000);
        assert.match(err.message, /no player/);
        return true;
      },
    );
    mod.setHandler('player.state', () => ({ name: 'Steve', health: 20 }));
  });

  it('maps 401 to -32002 with the token hint', async () => {
    await assert.rejects(
      () => client({ token: 'wrong' }).call('mod.ping'),
      (err: unknown) => {
        assert.ok(err instanceof McmcpError);
        assert.equal(err.code, -32002);
        assert.match(err.message, /rejected the token/);
        return true;
      },
    );
  });

  it('times out with an actionable -32000 message', async () => {
    const slow = await startFakeMod({ token: 'secret', rpcDelayMs: 400, handlers: { 'mod.ping': () => ({ pong: true }) } });
    try {
      await assert.rejects(
        () =>
          new ModClient({
            baseUrl: slow.url,
            host: '127.0.0.1',
            port: slow.port,
            token: 'secret',
            timeoutMs: 80,
          }).call('mod.ping'),
        (err: unknown) => {
          assert.ok(err instanceof McmcpError);
          assert.equal(err.code, -32000);
          assert.match(err.message, /cannot reach the Minecraft client/);
          assert.match(err.message, /Is the game running/);
          return true;
        },
      );
    } finally {
      await slow.close();
    }
  });

  it('long-polls /events with after/timeoutMs/types', async () => {
    const result = await client().events(6, 250, ['chat', 'screen']);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.seq, 7);
    assert.equal(result.next, 1);
  });

  it('reports health without auth', async () => {
    const health = await client({ token: 'whatever' }).health();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'mcmcp');
    assert.equal(health.mc, '1.21.4');
  });

  it('lists the method catalog', async () => {
    const methods = await client().methods();
    assert.ok(methods.length >= 3);
    assert.ok(methods.some((m) => m.name === 'gui.screen'));
  });
});

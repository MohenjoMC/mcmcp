/**
 * Test helper: an in-process HTTP server that behaves like the mcmcp mod.
 * Used by the protocol, config and MCP tests; never touches the network beyond
 * a loopback port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  authorization: string | null;
  id: unknown;
}

export type FakeHandler = (params: Record<string, unknown>, call: FakeCall) => unknown | Promise<unknown>;

export interface FakeModOptions {
  /** Require this bearer token; requests without it get 401. */
  token?: string;
  /** Per-method handlers. Unhandled methods answer -32601. */
  handlers?: Record<string, FakeHandler>;
  /** Delay every /rpc response (for timeout tests). */
  rpcDelayMs?: number;
  /** Method catalog returned by /methods. */
  methods?: unknown[];
  /** Health payload overrides. */
  health?: Record<string, unknown>;
  /** Events returned by /events. */
  events?: unknown[];
}

export interface FakeMod {
  url: string;
  port: number;
  calls: FakeCall[];
  setHandler(method: string, handler: FakeHandler): void;
  close(): Promise<void>;
}

const DEFAULT_METHODS = [
  { name: 'status', summary: 'Status.', params: {}, returns: '{}' },
  { name: 'gui.screen', summary: 'Current screen.', params: {}, returns: '{}' },
  { name: 'gui.click', summary: 'Click a widget.', params: {}, returns: '{}' },
  { name: 'player.state', summary: 'Player state.', params: {}, returns: '{}' },
  { name: 'mod.ping', summary: 'Ping.', params: {}, returns: '{}' },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeMod(opts: FakeModOptions = {}): Promise<FakeMod> {
  const handlers = new Map<string, FakeHandler>(Object.entries(opts.handlers ?? {}));
  const calls: FakeCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authorization = req.headers.authorization ?? null;

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'mcmcp',
          version: '1.0.0',
          mc: '1.21.4',
          player: 'Steve',
          inWorld: true,
          uptimeMs: 1234,
          ...opts.health,
        });
        return;
      }

      const authorized = opts.token === undefined || authorization === `Bearer ${opts.token}`;
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (url.pathname === '/methods') {
        sendJson(res, 200, opts.methods ?? DEFAULT_METHODS);
        return;
      }

      if (url.pathname === '/events') {
        const timeoutMs = Number(url.searchParams.get('timeoutMs') ?? '0');
        const events = opts.events ?? [{ seq: 1, time: Date.now(), type: 'chat', data: { text: 'hi', kind: 'chat' } }];
        if (events.length === 0) await sleep(Math.min(timeoutMs, 300));
        sendJson(res, 200, { events, next: events.length ? 1 : 0 });
        return;
      }

      if (url.pathname === '/shutdown' && req.method === 'POST') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/rpc' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          id?: unknown;
          method?: string;
          params?: Record<string, unknown>;
        };
        const call: FakeCall = {
          method: body.method ?? '',
          params: body.params ?? {},
          authorization,
          id: body.id,
        };
        calls.push(call);
        if (opts.rpcDelayMs) await sleep(opts.rpcDelayMs);

        const handler = handlers.get(call.method);
        if (!handler) {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32601, message: `unknown method ${call.method}`, data: { method: call.method } },
          });
          return;
        }
        try {
          const result = await handler(call.params, call);
          sendJson(res, 200, { jsonrpc: '2.0', id: body.id ?? null, result });
        } catch (err) {
          const error = err as { code?: number; message?: string; data?: unknown };
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: {
              code: typeof error.code === 'number' ? error.code : -32000,
              message: error.message ?? 'error',
              data: error.data,
            },
          });
        }
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    setHandler(method: string, handler: FakeHandler): void {
      handlers.set(method, handler);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** A pid that is certainly not running. */
export function deadPid(): number {
  return 2_147_483_646;
}

/**
 * Wire protocol types and the HTTP client for the mcmcp mod.
 * See docs/PROTOCOL.md for the contract this file implements.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  version: string;
  mc: string;
  player: string | null;
  inWorld: boolean;
  uptimeMs: number;
}

export interface MethodParam {
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface MethodSpec {
  name: string;
  summary: string;
  params: Record<string, MethodParam>;
  returns: string;
}

export interface McEvent {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}

export interface RuntimeDescriptor {
  pid: number;
  port: number;
  mcVersion: string;
  modVersion: string;
  player: string | null;
  startedAt: number;
  host?: string;
}

export class McmcpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McmcpError';
    this.code = code;
    this.data = data;
  }
}

export interface ClientOptions {
  host?: string;
  port?: number;
  token?: string;
  timeoutMs?: number;
  /** Skip discovery and talk to this base URL. */
  baseUrl?: string;
}

const DEFAULT_TIMEOUT = 35_000;

export class ModClient {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly timeoutMs: number;
  readonly baseUrl: string;
  private nextId = 1;

  constructor(opts: ClientOptions & { token: string }) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 25585;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.baseUrl = opts.baseUrl ?? `http://${this.host}:${this.port}`;
  }

  get address(): string {
    return this.baseUrl;
  }

  async health(timeoutMs = 2000): Promise<HealthInfo> {
    const res = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new McmcpError(-32000, `health check failed: HTTP ${res.status}`);
    return (await res.json()) as HealthInfo;
  }

  async methods(): Promise<MethodSpec[]> {
    const res = await this.get('/methods');
    return (await res.json()) as MethodSpec[];
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new McmcpError(
        -32000,
        `cannot reach the Minecraft client at ${this.baseUrl} (${msg}). Is the game running with the mcmcp mod?`,
      );
    });

    if (res.status === 401 || res.status === 403) {
      throw new McmcpError(-32002, `the client rejected the token from config (HTTP ${res.status})`, {
        address: this.baseUrl,
      });
    }
    const json = (await res.json().catch(() => null)) as
      | { result?: T; error?: JsonRpcError }
      | null;
    if (!json) throw new McmcpError(-32100, `malformed response from ${this.baseUrl}`);
    if (json.error) throw new McmcpError(json.error.code, json.error.message, json.error.data);
    return json.result as T;
  }

  async events(after?: number, timeoutMs = 5000, types?: string[]): Promise<{ events: McEvent[]; next: number }> {
    const q = new URLSearchParams();
    if (after !== undefined) q.set('after', String(after));
    q.set('timeoutMs', String(timeoutMs));
    if (types?.length) q.set('types', types.join(','));
    const res = await this.get(`/events?${q.toString()}`, timeoutMs + 2000);
    return (await res.json()) as { events: McEvent[]; next: number };
  }

  async shutdown(): Promise<void> {
    await this.post('/shutdown');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async get(path: string, timeoutMs = this.timeoutMs): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      throw new McmcpError(-32002, `the client rejected the token from config (HTTP ${res.status})`);
    }
    if (!res.ok) throw new McmcpError(-32000, `HTTP ${res.status} from ${path}`);
    return res;
  }

  private async post(path: string, timeoutMs = this.timeoutMs): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new McmcpError(-32000, `HTTP ${res.status} from ${path}`);
    return res;
  }
}

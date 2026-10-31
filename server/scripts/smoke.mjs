#!/usr/bin/env node
/**
 * End-to-end smoke test: start `mcmcp serve` exactly as OpenCode does, speak MCP to
 * it over stdio, and call the tools a real session would call. Requires a running
 * Minecraft client with the mcmcp mod.
 *
 *   node scripts/smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'serve'],
  stderr: 'inherit',
});

const client = new Client({ name: 'mcmcp-smoke', version: '1.0.0' });
await client.connect(transport);

function show(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  console.log(`\n### ${label}\n${text.slice(0, 2000)}`);
}

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);

const status = await client.callTool({ name: 'mc_status', arguments: {} });
show('mc_status', status.content?.map((c) => c.text).join('\n') ?? status);

const screen = await client.callTool({ name: 'mc_screen', arguments: { action: 'inspect' } });
show('mc_screen inspect', screen.content?.map((c) => c.text).join('\n') ?? screen);

const options = await client.callTool({ name: 'mc_options', arguments: { action: 'get', key: 'renderDistance' } });
show('mc_options get renderDistance', options.content?.map((c) => c.text).join('\n') ?? options);

const events = await client.callTool({ name: 'mc_events', arguments: { timeoutMs: 200 } });
show('mc_events', events.content?.map((c) => c.text).join('\n') ?? events);

const unknown = await client.callTool({ name: 'mc_raw', arguments: { method: 'nope.nope' } });
console.log(`\n### mc_raw unknown -> isError=${unknown.isError}\n${unknown.content?.[0]?.text ?? ''}`);

await client.close();
console.log('\nsmoke: ok');

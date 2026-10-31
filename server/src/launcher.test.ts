import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { launchInstance } from './launcher.js';
import { McmcpError } from './protocol.js';
import type { InstanceRoot } from './instances.js';

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('launchInstance', () => {
  let root: string;
  let instancesDir: string;
  let vanillaDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mcmcp-launch-'));
    instancesDir = path.join(root, 'instances');
    vanillaDir = path.join(root, 'minecraft');
    mkdirSync(vanillaDir, { recursive: true });

    const fabric = path.join(instancesDir, 'FabricTest');
    write(path.join(fabric, 'instance.cfg'), 'name=Fabric Test\n');
    write(
      path.join(fabric, 'mmc-pack.json'),
      JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.4' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.9' }] }),
    );
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.MCMCP_PRISM_DIRS;
    rmSync(root, { recursive: true, force: true });
  });

  function roots(): InstanceRoot[] {
    return [
      { launcher: 'prism', dir: instancesDir },
      { launcher: 'vanilla', dir: vanillaDir },
    ];
  }

  it('refuses to launch a plain .minecraft instance', async () => {
    await assert.rejects(
      () => launchInstance('vanilla', { roots: roots(), wait: false }),
      (err: unknown) => err instanceof McmcpError && err.code === -32003 && /no launcher command/.test(err.message),
    );
  });

  it('explains a missing PrismLauncher binary', async () => {
    originalPath = process.env.PATH;
    process.env.PATH = '';
    process.env.MCMCP_PRISM_DIRS = ''; // keep the test hermetic: no AppImage search
    await assert.rejects(
      () => launchInstance('FabricTest', { roots: roots(), wait: false }),
      (err: unknown) =>
        err instanceof McmcpError && err.code === -32100 && /PrismLauncher not found/.test(err.message),
    );
  });

  it('spawns prismlauncher and times out waiting for a client', async () => {
    const binDir = path.join(root, 'bin');
    const fake = path.join(binDir, 'prismlauncher');
    write(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    const started = Date.now();
    await assert.rejects(
      () => launchInstance('FabricTest', { roots: roots(), wait: true, timeoutMs: 700 }),
      (err: unknown) => err instanceof McmcpError && err.code === -32001 && /no mcmcp client appeared/.test(err.message),
    );
    assert.ok(Date.now() - started >= 250, 'must not busy-loop faster than 250 ms');
  });
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  findInstance,
  findModJars,
  installMod,
  listInstances,
  parseInstanceCfg,
  parseMmcPack,
  parseModVersion,
  readInstanceLog,
  uninstallMod,
  type InstanceRoot,
} from './instances.js';
import { McmcpError } from './protocol.js';

interface Tree {
  root: string;
  instancesDir: string;
  vanillaDir: string;
  roots: InstanceRoot[];
  jarPath: string;
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeTree(): Tree {
  const root = mkdtempSync(path.join(tmpdir(), 'mcmcp-instances-'));
  const instancesDir = path.join(root, 'instances');
  const vanillaDir = path.join(root, 'minecraft');

  // Fabric instance with an older mod jar.
  const fabric = path.join(instancesDir, 'FabricTest');
  write(path.join(fabric, 'instance.cfg'), 'InstanceType=OneSix\nname=Fabric Test\niconKey=fabric\n');
  write(
    path.join(fabric, 'mmc-pack.json'),
    JSON.stringify({
      formatVersion: 1,
      components: [
        { uid: 'net.minecraft', version: '1.21.4' },
        { uid: 'net.fabricmc.fabric-loader', version: '0.16.9' },
      ],
    }),
  );
  write(path.join(fabric, 'minecraft', 'mods', 'mcmcp-0.9.0.jar'), 'old');

  // Second Fabric instance with no mods dir at all.
  const empty = path.join(instancesDir, 'EmptyFabric');
  write(path.join(empty, 'instance.cfg'), 'name=Empty Fabric\n');
  write(
    path.join(empty, 'mmc-pack.json'),
    JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.3' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.8' }] }),
  );

  // Forge instance.
  const forge = path.join(instancesDir, 'ForgeTest');
  write(path.join(forge, 'instance.cfg'), 'name=Forge Test\n');
  write(
    path.join(forge, 'mmc-pack.json'),
    JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: '47.2.0' }] }),
  );

  // Instance with an overridden game dir.
  const custom = path.join(instancesDir, 'CustomDir');
  write(path.join(custom, 'instance.cfg'), `name=Custom\nOverrideGameDir=${path.join(root, 'shared-game')}\n`);
  write(path.join(custom, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }] }));

  // Directory without metadata must be ignored.
  mkdirSync(path.join(instancesDir, 'not-an-instance'), { recursive: true });

  // Vanilla tree with a fabric mod.
  write(path.join(vanillaDir, 'mods', 'mcmcp-fabric-26.1.2-1.0.0.jar'), 'vanilla');
  write(path.join(vanillaDir, 'versions', 'fabric-loader-0.16.10-1.21.5', 'fabric-loader-0.16.10-1.21.5.json'), '{}');

  const jarPath = path.join(root, 'dist', 'mcmcp-1.0.0.jar');
  write(jarPath, 'new-jar-bytes');

  return {
    root,
    instancesDir,
    vanillaDir,
    roots: [
      { launcher: 'prism', dir: instancesDir },
      { launcher: 'vanilla', dir: vanillaDir },
    ],
    jarPath,
  };
}

describe('instance discovery', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = makeTree();
  });

  afterEach(() => {
    rmSync(tree.root, { recursive: true, force: true });
  });

  it('parses instance.cfg key=value pairs', () => {
    const cfg = parseInstanceCfg('# comment\nname=My Pack\nInstanceType=OneSix\n\nkey = value \n');
    assert.equal(cfg.name, 'My Pack');
    assert.equal(cfg.InstanceType, 'OneSix');
    assert.equal(cfg.key, 'value');
  });

  it('parses mmc-pack components', () => {
    const pack = parseMmcPack('{"components":[{"uid":"net.minecraft","version":"1.21.4"}]}');
    assert.equal(pack.components?.[0]?.version, '1.21.4');
    assert.deepEqual(parseMmcPack('not json'), { components: [] });
  });

  it('parses versions out of mod jar names', () => {
    assert.equal(parseModVersion('mcmcp-1.0.0.jar'), '1.0.0');
    assert.equal(parseModVersion('mcmcp-fabric-26.1.2-1.0.0.jar'), '1.0.0');
    assert.equal(parseModVersion('mcmcp-1.2.3+mc1.21.4.jar'), '1.2.3+mc1.21.4');
    assert.equal(parseModVersion('something.jar'), null);
  });

  it('lists Prism and vanilla instances with loader and mod state', () => {
    const instances = listInstances({ roots: tree.roots });
    const fabric = instances.find((i) => i.id === 'FabricTest');
    assert.ok(fabric);
    assert.equal(fabric.name, 'Fabric Test');
    assert.equal(fabric.launcher, 'prism');
    assert.equal(fabric.mcVersion, '1.21.4');
    assert.equal(fabric.loader, 'fabric');
    assert.equal(fabric.loaderVersion, '0.16.9');
    assert.equal(fabric.fabric, true);
    assert.equal(fabric.hasMod, true);
    assert.equal(fabric.modVersion, '0.9.0');
    assert.equal(fabric.modsDir, path.join(tree.instancesDir, 'FabricTest', 'minecraft', 'mods'));

    const forge = instances.find((i) => i.id === 'ForgeTest');
    assert.ok(forge);
    assert.equal(forge.loader, 'forge');
    assert.equal(forge.fabric, false);
    assert.equal(forge.hasMod, false);

    const custom = instances.find((i) => i.id === 'CustomDir');
    assert.ok(custom);
    assert.equal(custom.gameDir, path.join(tree.root, 'shared-game'));

    assert.equal(instances.some((i) => i.id === 'not-an-instance'), false);

    const vanilla = instances.find((i) => i.launcher === 'vanilla');
    assert.ok(vanilla);
    assert.equal(vanilla.loader, 'fabric');
    assert.equal(vanilla.loaderVersion, '0.16.10');
    assert.equal(vanilla.mcVersion, '1.21.5');
    assert.equal(vanilla.hasMod, true);
    assert.equal(vanilla.modVersion, '1.0.0');
  });

  it('finds instances by id and by display name, with a helpful miss', () => {
    assert.equal(findInstance('fabrictest', { roots: tree.roots }).id, 'FabricTest');
    assert.equal(findInstance('Fabric Test', { roots: tree.roots }).id, 'FabricTest');
    assert.throws(
      () => findInstance('nope', { roots: tree.roots }),
      (err: unknown) => err instanceof McmcpError && /FabricTest/.test(err.message),
    );
  });

  it('installs the jar, removing older mcmcp jars', () => {
    const fabric = findInstance('FabricTest', { roots: tree.roots });
    const outcomes = installMod([fabric], tree.jarPath);
    assert.equal(outcomes.length, 1);
    const outcome = outcomes[0];
    assert.ok(outcome);
    assert.equal(outcome.action, 'installed');
    assert.deepEqual(outcome.removed, ['mcmcp-0.9.0.jar']);

    const mods = readdirSync(fabric.modsDir).sort();
    assert.deepEqual(mods, ['mcmcp-1.0.0.jar']);
    assert.equal(outcome.path, path.join(fabric.modsDir, 'mcmcp-1.0.0.jar'));
  });

  it('creates mods/ when the instance has none', () => {
    const empty = findInstance('EmptyFabric', { roots: tree.roots });
    assert.equal(existsSync(empty.modsDir), false);
    installMod([empty], tree.jarPath);
    assert.deepEqual(readdirSync(empty.modsDir), ['mcmcp-1.0.0.jar']);
  });

  it('refuses non-Fabric instances in strict mode and skips them otherwise', () => {
    const forge = findInstance('ForgeTest', { roots: tree.roots });
    assert.throws(
      () => installMod([forge], tree.jarPath),
      (err: unknown) => err instanceof McmcpError && err.code === -32003 && /Fabric mod/.test(err.message),
    );

    const outcomes = installMod(listInstances({ roots: tree.roots }), tree.jarPath, { strict: false });
    const forgeOutcome = outcomes.find((o) => o.instance.id === 'ForgeTest');
    assert.ok(forgeOutcome);
    assert.equal(forgeOutcome.action, 'skipped');
    assert.match(String(forgeOutcome.reason), /forge/);
  });

  it('rejects a missing jar and a non-jar path', () => {
    const fabric = findInstance('FabricTest', { roots: tree.roots });
    assert.throws(
      () => installMod([fabric], path.join(tree.root, 'missing.jar')),
      (err: unknown) => err instanceof McmcpError && /not found/.test(err.message),
    );
    assert.throws(
      () => installMod([fabric], path.join(fabric.path, 'instance.cfg')),
      (err: unknown) => err instanceof McmcpError && /not a jar/.test(err.message),
    );
  });

  it('uninstalls every mcmcp jar', () => {
    const fabric = findInstance('FabricTest', { roots: tree.roots });
    write(path.join(fabric.modsDir, 'mcmcp-1.0.0.jar'), 'x');
    write(path.join(fabric.modsDir, 'other-mod.jar'), 'y');
    const outcome = uninstallMod(fabric);
    assert.deepEqual(outcome.removed.sort(), ['mcmcp-0.9.0.jar', 'mcmcp-1.0.0.jar']);
    assert.deepEqual(readdirSync(fabric.modsDir), ['other-mod.jar']);
  });

  it('reads the log tail', () => {
    const fabric = findInstance('FabricTest', { roots: tree.roots });
    const log = path.join(fabric.gameDir, 'logs', 'latest.log');
    write(log, `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n`);
    const tail = readInstanceLog(fabric, 3);
    assert.deepEqual(tail.lines, ['line 7', 'line 8', 'line 9']);
    assert.equal(tail.path, log);
    assert.throws(
      () => readInstanceLog(findInstance('ForgeTest', { roots: tree.roots }), 5),
      (err: unknown) => err instanceof McmcpError && /no log file/.test(err.message),
    );
  });

  it('lists mcmcp jars only', () => {
    const fabric = findInstance('FabricTest', { roots: tree.roots });
    write(path.join(fabric.modsDir, 'sodium.jar'), 'x');
    assert.deepEqual(findModJars(fabric.modsDir), ['mcmcp-0.9.0.jar']);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgv } from './cli.js';

describe('cli argument parsing', () => {
  it('separates positionals and flags', () => {
    const parsed = parseArgv(['call', 'player.state', '{"x":1}', '--json']);
    assert.deepEqual(parsed.positionals, ['call', 'player.state', '{"x":1}']);
    assert.equal(parsed.flags.json, true);
  });

  it('supports --flag=value', () => {
    const parsed = parseArgv(['logs', '--instance=Fabric', '--lines=20']);
    assert.equal(parsed.flags.instance, 'Fabric');
    assert.equal(parsed.flags.lines, '20');
  });

  it('supports --flag value', () => {
    const parsed = parseArgv(['install', '--instance', 'Fabric', '--jar', '/tmp/x.jar']);
    assert.deepEqual(parsed.positionals, ['install']);
    assert.equal(parsed.flags.instance, 'Fabric');
    assert.equal(parsed.flags.jar, '/tmp/x.jar');
  });

  it('treats known switches as booleans and supports -h', () => {
    const parsed = parseArgv(['launch', 'Fabric', '--no-wait', '-h']);
    assert.equal(parsed.flags['no-wait'], true);
    assert.equal(parsed.flags.help, true);
    assert.deepEqual(parsed.positionals, ['launch', 'Fabric']);
  });

  it('treats a trailing flag with no value as a boolean', () => {
    const parsed = parseArgv(['install', '--all']);
    assert.equal(parsed.flags.all, true);
  });

  it('keeps everything after -- as positionals', () => {
    const parsed = parseArgv(['call', '--', '--json']);
    assert.deepEqual(parsed.positionals, ['call', '--json']);
    assert.equal(parsed.flags.json, undefined);
  });
});

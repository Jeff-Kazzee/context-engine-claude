// Setup restores runner config from records it wrote earlier. A record or backup that is gone or
// foreign cannot say what to restore, so setup refuses before it changes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { tree, world } from './testing/world.ts';

const snapshotOf = (record: string) => JSON.parse(readFileSync(record, 'utf8')).dir as string;

test('[LIFE-015] a missing before backup of an interrupted install refuses the undo', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, '{}');
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  const copy = join(snapshotOf(pending), 'before', '0-settings.json');
  unlinkSync(copy);
  const afterKill = readFileSync(settings, 'utf8');

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses an undo without its before backup. It said:\n${r.stdout}`);
  for (const name of [copy, pending]) assert.ok(r.stderr.includes(name), `the refusal names ${name}:\n${r.stderr}`);
  assert.equal(existsSync(settings) ? readFileSync(settings, 'utf8') : null, afterKill, 'settings.json is left as the kill left it');
  assert.ok(existsSync(pending), 'the interrupted install record stays');
});

test('[LIFE-004] uninstall refuses an install whose before backup is missing', () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, '{}');
  assert.equal(w.ce(['install']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'claude.json');
  const copy = join(snapshotOf(pointer), 'before', '0-settings.json');
  unlinkSync(copy);
  const installed = readFileSync(settings, 'utf8');

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses without the before backup. It said:\n${r.stdout}`);
  assert.ok(r.stderr.includes(copy), `the refusal names ${copy}:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /did not exist before install/);
  assert.equal(existsSync(settings) ? readFileSync(settings, 'utf8') : null, installed, 'settings.json is unchanged');
  assert.ok(existsSync(pointer), 'the install record stays');
});

test('[LIFE-015] a foreign interrupted install record refuses uninstall before any change', () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, '{"theme": "dark"}\n');
  assert.equal(w.ce(['install']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'claude.json');
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  writeFileSync(pending, JSON.stringify({ version: 1, kind: 'claude', dir: join(tempDir('elsewhere'), 'claude-x'), files: [], namespaced: [], watch: [], listing: [] }), { mode: 0o600 });
  const installed = tree(w.claudeHome);

  for (const attempt of [1, 2]) {
    const r = w.ce(['uninstall']);
    assert.notEqual(r.status, 0, `uninstall ${attempt} refuses a record it cannot verify. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending), `uninstall ${attempt} names ${pending}:\n${r.stderr}`);
    assert.deepEqual(tree(w.claudeHome), installed, `uninstall ${attempt} changed nothing`);
    assert.ok(existsSync(pointer), 'the install record stays');
    assert.match(r.stderr, /move the record aside/, `uninstall ${attempt} gives a next step:\n${r.stderr}`);
  }

  rmSync(pending);
  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(settings, 'utf8'), '{"theme": "dark"}\n');
});

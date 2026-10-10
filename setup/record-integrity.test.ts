// Setup restores runner config from records it wrote earlier. A foreign record cannot say what to
// restore, so setup refuses before it changes anything. A backup copy that is gone is never read as
// an absent file: uninstall removes only Context Engine's entries from that file and names the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { tree, world } from './testing/world.ts';

const snapshotOf = (record: string) => JSON.parse(readFileSync(record, 'utf8')).dir as string;

test('[LIFE-015] a missing before backup of an interrupted install is reported, never read as an absent file', async () => {
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

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(settings), 'settings.json is never deleted on the word of a missing backup');
  assert.doesNotMatch(readFileSync(settings, 'utf8'), /context-engine/, 'only Context Engine entries were removed');
  assert.ok(r.stdout.includes(`because its before backup ${copy} is missing`), `uninstall names the copy it could not use:\n${r.stdout}`);
  assert.equal(existsSync(pending), false, 'the undo finished');
});

test('[LIFE-004] a missing backup copy blocks no command, and uninstall names the file it could not restore', () => {
  for (const which of ['before', 'after']) {
    const w = world();
    const settings = join(w.claudeHome, 'settings.json');
    writeFileSync(settings, '{}');
    assert.equal(w.ce(['install']).status, 0);
    const pointer = join(w.stateDir, 'setup', 'claude.json');
    const copy = join(snapshotOf(pointer), which, '0-settings.json');
    unlinkSync(copy);

    for (const command of ['status', 'enable']) {
      const r = w.ce([command]);
      assert.equal(r.status, 0, `${which}: ${command} does not read backup copies:\n${r.stderr}`);
    }
    assert.match(w.ce(['install']).stderr, /already installed/, `${which}: install still says it is installed`);
    const r = w.ce(['uninstall']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(settings), `${which}: settings.json is never deleted on the word of a missing backup`);
    assert.doesNotMatch(readFileSync(settings, 'utf8'), /context-engine/, `${which}: only Context Engine entries were removed`);
    const line = r.stdout.split('\n').find((l) => l.includes(`${settings}:`)) ?? '';
    assert.ok(line.includes(copy), `${which}: uninstall names the copy it could not use:\n${r.stdout}`);
    assert.doesNotMatch(line, /did not exist before install|restored byte for byte/, `${which}: no restore is claimed`);
    assert.equal(existsSync(pointer), false, `${which}: the install record is retired`);
  }
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

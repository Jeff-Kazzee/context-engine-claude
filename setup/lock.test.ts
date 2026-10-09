import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { tree, world } from './testing/world.ts';

test('[CLI-008] a live Claude setup process blocks enable, disable and uninstall', async () => {
  const w = world();
  const lock = join(w.stateDir, 'setup', 'claude.setup.lock');
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try {
    await waitForFile(pause);
    const project = tree(w.project);
    for (const command of ['enable', 'disable', 'uninstall']) {
      const r = w.ce([command]);
      assert.notEqual(r.status, 0, `${command} ran while install held the lock`);
      assert.ok(r.stderr.includes(lock), `${command} names ${lock}:\n${r.stderr}`);
    }
    assert.equal(existsSync(join(w.stateDir, 'participation')), false, 'no participation record');
    assert.deepEqual(tree(w.project), project);
    const status = w.ce(['status', '--json']);
    assert.equal(status.status, 0, `status takes no lock:\n${status.stderr}`);
    writeFileSync(`${pause}.release`, '');
    const done = await install.done;
    assert.equal(done.code, 0, done.stdout + done.stderr);
  } finally { killGroup(install.pid); }
  assert.equal(existsSync(lock), false, 'install released its lock');
  assert.equal(w.ce(['enable']).status, 0);
});

test('[CLI-008] a Codex setup lock does not block Claude setup', () => {
  const w = world();
  mkdirSync(join(w.stateDir, 'setup'), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.stateDir, 'setup', 'codex.setup.lock'), '{"pid":1}\n');
  const install = w.ce(['install']);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(w.ce(['enable']).status, 0);
  assert.equal(w.ce(['disable']).status, 0);
  assert.equal(w.ce(['uninstall']).status, 0);
});

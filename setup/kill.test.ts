// A setup process killed mid-run skips every in-process rollback. The next runs must finish, undo or
// refuse the interrupted operation, and never adopt half-applied runner config as a new baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { world } from './testing/world.ts';

const SETTINGS = '{"theme": "dark",\n  "env": {"FOO": "1"}}\n';
// Seeded registries: a fresh install and uninstall leaves absent ones behind as runner residue.
const INSTALLED = '{"version": 2, "plugins": {"other@mkt": [{"scope": "user", "installPath": "/opt/other", "version": "1.0.0"}]}}\n';
const KNOWN = '{"mkt": {"source": {"source": "directory", "path": "/opt/mkt"}, "installLocation": "/opt/mkt"}}\n';
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

test('[LIFE-015] SIGKILL during Claude install never becomes a silent baseline', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  const tracked = [settings, join(w.claudeHome, 'plugins', 'installed_plugins.json'), join(w.claudeHome, 'plugins', 'known_marketplaces.json')];
  mkdirSync(join(w.claudeHome, 'plugins'));
  for (const [path, text] of [[tracked[0]!, SETTINGS], [tracked[1]!, INSTALLED], [tracked[2]!, KNOWN]] as const) writeFileSync(path, text);
  const preKill = tracked.map(read);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  assert.match(read(settings)!, /extraKnownMarketplaces/, 'the kill left the marketplace half-applied');

  const lock = join(w.stateDir, 'setup', 'claude.setup.lock');
  for (const command of ['enable', 'disable', 'install', 'uninstall']) {
    const blocked = w.ce([command]);
    assert.notEqual(blocked.status, 0, `${command} ran past the stale lock`);
    assert.ok(blocked.stderr.includes(lock), `${command} names ${lock}:\n${blocked.stderr}`);
  }
  rmSync(lock);

  const again = w.ce(['install']);
  if (again.status !== 0) {
    assert.ok(again.stderr.includes(join(w.stateDir, 'setup', 'backups')), `a refusal names the orphan snapshot:\n${again.stderr}`);
    return;
  }
  const removed = w.ce(['uninstall']);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(tracked.map(read), preKill, `uninstall returns the pre-kill bytes. It said:\n${removed.stdout}`);
  assert.equal(existsSync(join(w.claudeHome, 'plugins', 'cache', 'context-engine')), false);
});

test('[LIFE-015] enable and status refuse until an interrupted install is undone', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, SETTINGS);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  assert.ok(existsSync(pending), 'the kill left the interrupted install record');

  for (const args of [['enable'], ['status'], ['status', '--json']]) {
    const r = w.ce(args);
    assert.notEqual(r.status, 0, `${args.join(' ')} refuses while the interrupted install is not undone. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending), `${args.join(' ')} names ${pending}:\n${r.stderr}`);
    for (const recovery of ['context-engine-claude install', 'context-engine-claude uninstall']) assert.ok(r.stderr.includes(recovery), `${args.join(' ')} names \`${recovery}\`:\n${r.stderr}`);
  }
  assert.equal(existsSync(join(w.stateDir, 'participation')), false, 'the refused enable wrote no participation record');

  const undo = w.ce(['uninstall']);
  assert.equal(undo.status, 0, undo.stdout + undo.stderr);
  assert.equal(read(settings), SETTINGS);
  const enabled = w.ce(['enable']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(w.ce(['status']).status, 0, 'status works again after the undo');
});

test('[LIFE-015] kill inside a guarded replacement never hides the live config', () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, SETTINGS);
  assert.equal(w.ce(['install']).status, 0);

  // A child uninstall is killed by its own fs.linkSync after settings.json was moved to its candidate name.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { uninstallLocked } = await import(${JSON.stringify(new URL('./install.ts', import.meta.url).href)});
    const { claudeSpec, setupContext } = await import(${JSON.stringify(new URL('./runners.ts', import.meta.url).href)});
    const native = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (String(from).includes('.context-engine-setup-') && String(to).endsWith('/settings.json')) process.kill(process.pid, 'SIGKILL');
      return native(from, to);
    };
    syncBuiltinESMExports();
    const ctx = setupContext(process.env);
    uninstallLocked(ctx, claudeSpec(ctx));
  `], { env: { ...process.env, ...w.env }, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const candidates = readdirSync(w.claudeHome).filter((name) => name.startsWith('.context-engine-replace-'));
  assert.equal(candidates.length, 1, 'the kill left one replacement candidate');
  assert.equal(existsSync(settings), false, 'the kill left settings.json only under the candidate name');
  const candidate = join(w.claudeHome, candidates[0]!);
  const preRevert = readFileSync(candidate, 'utf8');

  const next = w.ce(['uninstall']);
  const now = read(settings);
  if (now !== null && [SETTINGS, preRevert].includes(now)) return;
  assert.ok(`${next.stdout}${next.stderr}`.includes(candidate), `the next run names the candidate. It said:\n${next.stdout}${next.stderr}\nsettings.json is now ${JSON.stringify(now)}`);
});

// A setup process killed mid-run skips every in-process rollback. The next runs must finish, undo or
// refuse the interrupted operation, and never adopt half-applied runner config as a new baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { killGroup, startSetup, waitForFile } from './testing/process.ts';
import { world, type World } from './testing/world.ts';

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

test('[LIFE-015] a refused undo names the file, the record and the snapshot without a stack trace', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, SETTINGS);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  const backups = join(w.stateDir, 'setup', 'backups');

  // A tracked file that no longer parses blocks the undo. The refusal says so and names what to repair.
  writeFileSync(settings, read(settings)!.replace(/\}\s*$/, ',}\n'));
  for (const command of ['install', 'uninstall']) {
    const r = w.ce([command]);
    assert.notEqual(r.status, 0, `${command} refuses an undo over unparsable JSON`);
    for (const name of [settings, pending, backups]) assert.ok(r.stderr.includes(name), `${command} names ${name}:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${command} prints no stack trace`);
    assert.doesNotMatch(r.stderr, /credential/, `${command} does not call a parse failure a credential`);
  }

  // A record that is not JSON cannot say what to undo. Every command names it.
  writeFileSync(pending, '{"dir": ');
  for (const command of ['install', 'uninstall', 'enable', 'status']) {
    const r = w.ce([command]);
    assert.notEqual(r.status, 0, `${command} refuses a corrupt interrupted install record`);
    assert.ok(r.stderr.includes(pending), `${command} names ${pending}:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${command} prints no stack trace`);
  }
});

test('[LIFE-015] a failed install still reports the undo of an interrupted one', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, SETTINGS);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  const interrupted = join(JSON.parse(readFileSync(pending, 'utf8')).dir, 'before');

  const failed = w.ce(['install'], { env: { FAKE_CLAUDE_FAIL: 'plugin install' } });
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.match(failed.stderr, /plugin install .* failed/);
  assert.ok(failed.stderr.includes('An earlier install was interrupted.'), `the failure reports the undo:\n${failed.stderr}`);
  assert.ok(failed.stderr.includes(interrupted), `the failure names the interrupted install's backups ${interrupted}:\n${failed.stderr}`);
  assert.equal(existsSync(pending), false, 'the undo finished');
  assert.equal(read(settings), SETTINGS);
});

test('[LIFE-015] an uninstall that only undoes an interrupted install does not claim an uninstall', async () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), SETTINGS);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /uninstalled/, `nothing was installed:\n${r.stdout}`);
  assert.match(r.stdout, /^Claude Code: not installed\. The interrupted install was rolled back\.$/m);
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

test('[LIFE-015] a kill after a guarded replacement is published names both leftovers', () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, SETTINGS);
  assert.equal(w.ce(['install']).status, 0);

  // A child uninstall is killed right after the restored bytes are linked into place, before the temporary name is removed.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { uninstallLocked } = await import(${JSON.stringify(new URL('./install.ts', import.meta.url).href)});
    const { claudeSpec, setupContext } = await import(${JSON.stringify(new URL('./runners.ts', import.meta.url).href)});
    const native = fs.linkSync;
    fs.linkSync = (from, to) => {
      native(from, to);
      if (String(from).includes('.context-engine-setup-') && String(to).endsWith('/settings.json')) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const ctx = setupContext(process.env);
    uninstallLocked(ctx, claudeSpec(ctx));
  `], { env: { ...process.env, ...w.env }, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const left = readdirSync(w.claudeHome).filter((name) => name.startsWith('.context-engine-')).map((name) => join(w.claudeHome, name));
  assert.equal(left.length, 2, `the kill left a temporary copy and a replacement candidate: ${left.join(', ')}`);
  assert.equal(lstatSync(settings).nlink, 2, 'settings.json shares its inode with the temporary copy');

  const next = w.ce(['uninstall']);
  assert.notEqual(next.status, 0, next.stdout);
  for (const path of left) assert.ok(next.stderr.includes(path), `the refusal names ${path}:\n${next.stderr}`);
  assert.doesNotMatch(next.stderr, /unverified or linked file/, `the leftovers explain the refusal, not the link count:\n${next.stderr}`);
});

/** Runs one setup step in a child process that the given fs patch kills. */
function killedStep(w: World, step: 'installLocked' | 'uninstallLocked', patch: string): void {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const setup = await import(${JSON.stringify(new URL('./install.ts', import.meta.url).href)});
    const { claudeSpec, setupContext } = await import(${JSON.stringify(new URL('./runners.ts', import.meta.url).href)});
    ${patch}
    syncBuiltinESMExports();
    const ctx = setupContext(process.env);
    setup[${JSON.stringify(step)}](ctx, claudeSpec(ctx));
  `], { env: { ...process.env, ...w.env }, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
}
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('.context-engine-')).map((name) => join(dir, name));


test('[LIFE-015] a kill after the install record is published leaves a working install', () => {
  for (const first of ['enable', 'install']) {
    const w = world();
    const tracked = join(w.claudeHome, 'settings.json');
    writeFileSync(tracked, SETTINGS);
    // The child install is killed as it removes its interrupted install record, after it published the install record.
    killedStep(w, 'installLocked', `const native = fs.unlinkSync; fs.unlinkSync = (p) => { if (String(p).endsWith('/claude.pending.json')) process.kill(process.pid, 'SIGKILL'); return native(p); };`);
    const pointer = join(w.stateDir, 'setup', 'claude.json'), pending = join(w.stateDir, 'setup', 'claude.pending.json');
    assert.equal(JSON.parse(readFileSync(pending, 'utf8')).dir, JSON.parse(readFileSync(pointer, 'utf8')).dir, 'both records name the finished install');

    const status = w.ce(['status']);
    assert.equal(status.status, 0, `status reports the finished install:\n${status.stderr}`);
    assert.ok(status.stdout.includes('install record present'), status.stdout);
    const r = w.ce([first]);
    if (first === 'enable') assert.equal(r.status, 0, r.stderr);
    else assert.match(r.stderr, /already installed/);
    assert.equal(existsSync(pending), false, `${first} removed the leftover record of the finished install`);
    assert.equal(w.ce(['uninstall']).status, 0);
    assert.equal(readFileSync(tracked, 'utf8'), SETTINGS);
  }
});
test('[LIFE-009] the refusal after a killed write gives the step that recovers each leftover', async () => {
  // Published: settings.json already holds the restored bytes, so both leftovers go.
  {
    const w = world();
    const settings = join(w.claudeHome, 'settings.json');
    writeFileSync(settings, SETTINGS);
    assert.equal(w.ce(['install']).status, 0);
    killedStep(w, 'uninstallLocked', `const native = fs.linkSync; fs.linkSync = (from, to) => { native(from, to); if (String(from).includes('.context-engine-setup-') && String(to).endsWith('/settings.json')) process.kill(process.pid, 'SIGKILL'); };`);
    const next = w.ce(['uninstall']);
    for (const path of leftovers(w.claudeHome)) {
      assert.ok(next.stderr.includes(`Remove ${path}.`), `the refusal says to remove ${path}:\n${next.stderr}`);
      rmSync(path);
    }
    const done = w.ce(['uninstall']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(read(settings), SETTINGS);
  }
  // Not yet published: settings.json exists only under the replacement candidate, which goes back.
  {
    const w = world();
    const settings = join(w.claudeHome, 'settings.json');
    writeFileSync(settings, SETTINGS);
    assert.equal(w.ce(['install']).status, 0);
    killedStep(w, 'uninstallLocked', `const native = fs.linkSync; fs.linkSync = (from, to) => { if (String(from).includes('.context-engine-setup-') && String(to).endsWith('/settings.json')) process.kill(process.pid, 'SIGKILL'); return native(from, to); };`);
    const next = w.ce(['uninstall']);
    for (const path of leftovers(w.claudeHome)) {
      if (basename(path).startsWith('.context-engine-replace-')) {
        assert.ok(next.stderr.includes(`Move ${path} back to ${settings}.`), `the refusal says to move ${path} back:\n${next.stderr}`);
        renameSync(path, settings);
      } else {
        assert.ok(next.stderr.includes(`Remove ${path}.`), `the refusal says to remove ${path}:\n${next.stderr}`);
        rmSync(path);
      }
    }
    const done = w.ce(['uninstall']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(read(settings), SETTINGS);
  }
  // A deletion moved known_marketplaces.json to its candidate during the undo of a killed install.
  {
    const w = world();
    const settings = join(w.claudeHome, 'settings.json');
    const known = join(w.claudeHome, 'plugins', 'known_marketplaces.json');
    writeFileSync(settings, SETTINGS);
    const pause = join(tempDir('pause'), 'plugin-install');
    const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
    try { await waitForFile(pause); } finally { killGroup(install.pid); }
    assert.equal((await install.done).signal, 'SIGKILL');
    rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
    killedStep(w, 'uninstallLocked', `const native = fs.renameSync; fs.renameSync = (from, to) => { native(from, to); if (String(to).includes('.context-engine-delete-')) process.kill(process.pid, 'SIGKILL'); };`);
    assert.equal(existsSync(known), false, 'the kill left known_marketplaces.json only under its candidate');
    const [candidate] = leftovers(join(w.claudeHome, 'plugins'));
    const next = w.ce(['uninstall']);
    assert.ok(next.stderr.includes(`Move ${candidate} back to ${known}.`), `the refusal says to move ${candidate} back:\n${next.stderr}`);
    renameSync(candidate!, known);
    const done = w.ce(['uninstall']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(existsSync(known), false, 'the undo deletes the file that did not exist before install');
    assert.equal(read(settings), SETTINGS);
  }
});

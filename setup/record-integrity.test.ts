// Setup restores runner config from records it wrote earlier. A foreign record cannot say what to
// restore, so setup refuses before it changes anything. A backup copy that is gone is never read as
// an absent file: uninstall removes only Context Engine's entries from that file and names the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

for (const forge of ['snapshot outside the backups directory', 'tracked file outside the runner policy']) {
  test(`[LIFE-015] an interrupted install record naming a ${forge} is refused before any change`, async () => {
    const w = world();
    const tracked = join(w.claudeHome, 'settings.json');
    writeFileSync(tracked, '{"theme": "dark"}\n');
    const pause = join(tempDir('pause'), 'plugin-install');
    const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
    try { await waitForFile(pause); } finally { killGroup(install.pid); }
    assert.equal((await install.done).signal, 'SIGKILL');
    rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
    const pending = join(w.stateDir, 'setup', 'claude.pending.json');
    const record = JSON.parse(readFileSync(pending, 'utf8')) as { dir: string; files: Array<{ path: string; before: string | null }> };
    if (forge.startsWith('snapshot')) {
      // A private snapshot with copies that would pass every later check, but outside setup/backups.
      const forged = join(tempDir('outside'), 'claude-forged');
      mkdirSync(join(forged, 'before'), { recursive: true, mode: 0o700 });
      record.files = record.files.map((f) => {
        if (f.before === null) return f;
        const copy = join(forged, 'before', basename(f.before));
        writeFileSync(copy, '{"theme": "forged"}\n', { mode: 0o600 });
        return { ...f, before: copy };
      });
      record.dir = forged;
    } else {
      const victim = join(w.home, 'victim.json');
      writeFileSync(victim, '{"keep": true}\n');
      record.files[0]!.path = victim;
    }
    writeFileSync(pending, JSON.stringify(record));
    const afterKill = readFileSync(tracked, 'utf8');

    const r = w.ce(['uninstall']);
    assert.notEqual(r.status, 0, `${forge}: uninstall refuses the record. It said:\n${r.stdout}`);
    assert.ok(r.stderr.includes(pending) && r.stderr.includes('violates confinement policy'), `${forge}: the refusal names the record and the policy:\n${r.stderr}`);
    assert.equal(readFileSync(tracked, 'utf8'), afterKill, `${forge}: settings.json is unchanged`);
    assert.ok(existsSync(pending), `${forge}: the record stays`);
  });
}

test('[SAFE-011] a hard-linked backup copy refuses uninstall before any runner command or change', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), '{"theme": "dark"}\n');
  assert.equal(w.ce(['install']).status, 0);
  const pointer = join(w.stateDir, 'setup', 'claude.json');
  const copy = join(snapshotOf(pointer), 'before', '0-settings.json');
  linkSync(copy, join(tempDir('second-link'), 'copy'));
  const installed = tree(w.claudeHome);

  const r = w.ce(['uninstall']);
  assert.notEqual(r.status, 0, `uninstall refuses a linked backup copy. It said:\n${r.stdout}`);
  assert.ok(r.stderr.includes(copy), `the refusal names ${copy}:\n${r.stderr}`);
  assert.deepEqual(tree(w.claudeHome), installed, 'no runner command ran and no tracked file changed');
  assert.ok(existsSync(pointer), 'the install record stays');
});

test('[LIFE-015] without its before backup the undo keeps every value it did not write and lists it', async () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  // A user value at a Context Engine key name that the killed install never wrote, and two empty containers.
  writeFileSync(settings, `${JSON.stringify({ theme: 'dark', enabledPlugins: { 'context-engine@context-engine': false }, pluginConfigs: {}, extraKnownMarketplaces: {} })}\n`);
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  const pending = join(w.stateDir, 'setup', 'claude.pending.json');
  unlinkSync(join(snapshotOf(pending), 'before', '0-settings.json'));

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { theme: 'dark', enabledPlugins: { 'context-engine@context-engine': false }, pluginConfigs: {}, extraKnownMarketplaces: {} },
    'only the marketplace entry the install wrote is gone, and every container stays');
  assert.ok(r.stdout.includes(`${settings}: enabledPlugins."context-engine@context-engine" left in place because the backup copy is missing`), r.stdout);
  assert.doesNotMatch(r.stdout, /Only Context Engine's entries were removed/, 'the report claims no more than it did');
});

test('[LIFE-004] without its before backup uninstall keeps containers it cannot prove it created', () => {
  const w = world();
  const settings = join(w.claudeHome, 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ theme: 'dark', pluginConfigs: {} })}\n`);
  assert.equal(w.ce(['install']).status, 0);
  unlinkSync(join(snapshotOf(join(w.stateDir, 'setup', 'claude.json')), 'before', '0-settings.json'));

  const r = w.ce(['uninstall']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(after.pluginConfigs, {}, 'the user\'s empty pluginConfigs stays, without the entries the install wrote');
  assert.equal(after.theme, 'dark');
  assert.doesNotMatch(readFileSync(settings, 'utf8'), /context-engine/);
});

async function killedInstallFor(w: ReturnType<typeof world>): Promise<string> {
  const pause = join(tempDir('pause'), 'plugin-install');
  const install = startSetup(['install'], { cwd: w.project, env: { ...w.env, FAKE_CLAUDE_PAUSE: pause } });
  try { await waitForFile(pause); } finally { killGroup(install.pid); }
  assert.equal((await install.done).signal, 'SIGKILL');
  rmSync(join(w.stateDir, 'setup', 'claude.setup.lock'));
  return join(w.stateDir, 'setup', 'claude.pending.json');
}

for (const run of ['undo']) {
  test(`[LIFE-015] a tracked file and its before backup both gone are reported by the copy (${run})`, async () => {
    const w = world();
    const tracked = join(w.claudeHome, 'settings.json');
    writeFileSync(tracked, '{"theme": "dark"}\n');
    let record: string;
    if (run === 'undo') record = await killedInstallFor(w);
    else { assert.equal(w.ce(['install']).status, 0); record = join(w.stateDir, 'setup', 'claude.json'); }
    const copy = join(snapshotOf(record), 'before', '0-settings.json');
    unlinkSync(copy);
    unlinkSync(tracked);

    const r = w.ce(['uninstall']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const line = r.stdout.split('\n').find((l) => l.includes(`${tracked}:`)) ?? '';
    assert.ok(line.includes(copy), `the report names the lost copy ${copy}:\n${r.stdout}`);
    assert.doesNotMatch(line, /removed/, `nothing is claimed removed from a file that is gone:\n${line}`);
    assert.equal(existsSync(tracked), false, 'settings.json stays missing');
  });
}

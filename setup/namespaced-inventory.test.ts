import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeLedger, rollbackSnapshot, takeSnapshot, type Snapshot } from './ledger.ts';
import { interruptedInstall } from './install.ts';
import { claudeSpec, setupContext } from './runners.ts';
import { tree, world } from './testing/world.ts';

const INVENTORY = /inventory exceeds entry, depth or path-byte limit/;

function unrelatedPlugins(home: string): string[] {
  const roots = [join(home, 'plugins', 'cache', 'another-marketplace'), join(home, 'plugins', 'marketplaces', 'another-marketplace')];
  for (const [group, root] of roots.entries()) {
    for (let plugin = 0; plugin < 24; plugin++) {
      const dir = join(root, `plugin-${plugin}`, '1.2.3', group === 0 ? 'skills' : 'source');
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 96; file++) writeFileSync(join(dir, `fixture-${file}.txt`), `UNRELATED ${group} ${plugin} ${file}\n`);
    }
  }
  return roots;
}

function snapshot(w: ReturnType<typeof world>, inventoryMode: Snapshot['inventoryMode'] = 'namespaced'): Snapshot {
  const ctx = setupContext(w.env), spec = claudeSpec(ctx);
  return takeSnapshot({ backupRoot: join(ctx.setupDir, 'backups'), kind: spec.id, files: spec.files, watch: spec.watch, namespaced: spec.namespaced, inventoryMode });
}

test('Claude install and uninstall preserve more than 4,096 unrelated cached plugin entries', () => {
  const w = world(), roots = unrelatedPlugins(w.claudeHome), before = roots.map(tree);
  const settings = join(w.claudeHome, 'settings.json');
  const original = '{ "theme": "dark", "enabledPlugins": { "other@another-marketplace": true } }\n';
  writeFileSync(settings, original);
  const installed = w.ce(['install']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Observed new paths.*Unrelated directory contents are not counted/);
  const pointer = JSON.parse(readFileSync(join(w.stateDir, 'setup', 'claude.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(join(pointer.dir, 'ledger.json'), 'utf8'));
  assert.ok(ledger.createdFiles.length > 0, 'owned plugin files are fully inventoried');
  assert.ok(ledger.createdFiles.every((file: { path: string }) => file.path.includes('/cache/context-engine/')));
  assert.deepEqual(roots.map(tree), before);
  const removed = w.ce(['uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(readFileSync(settings, 'utf8'), original);
  assert.deepEqual(roots.map(tree), before);
  assert.equal(existsSync(join(w.claudeHome, 'plugins', 'cache', 'context-engine')), false);
});

for (const action of ['complete', 'rollback'] as const) test(`${action} retains new opaque boundaries and their uncounted descendants`, () => {
  const w = world(), s = snapshot(w);
  const unrelated = join(w.claudeHome, 'plugins', 'cache', 'context-engine-other');
  mkdirSync(join(unrelated, 'deep'), { recursive: true });
  writeFileSync(join(unrelated, 'deep', 'keep.txt'), 'UNRELATED');
  const before = tree(unrelated);
  const observed = action === 'complete' ? completeLedger(s).retainedPaths! : rollbackSnapshot(s, claudeSpec(setupContext(w.env)).rules);
  assert.ok(observed.includes(`${unrelated}/`));
  assert.equal(observed.some(path => path.startsWith(`${unrelated}/deep`)), false);
  assert.deepEqual(tree(unrelated), before);
});

for (const phase of ['before', 'complete', 'rollback'] as const) test(`${phase} refuses an oversized owned namespace`, () => {
  const w = world(), owned = join(w.claudeHome, 'plugins', 'cache', 'context-engine');
  const s = phase === 'before' ? undefined : snapshot(w);
  mkdirSync(owned, { recursive: true });
  for (let i = 0; i < 4096; i++) writeFileSync(join(owned, `entry-${i}`), 'OWNED');
  const run = () => phase === 'before' ? snapshot(w) : phase === 'complete' ? completeLedger(s!) : rollbackSnapshot(s!, {});
  assert.throws(run, INVENTORY);
  assert.equal(readFileSync(join(owned, 'entry-4095'), 'utf8'), 'OWNED');
  if (phase === 'before') assert.equal(existsSync(join(w.stateDir, 'setup', 'backups')), false);
});

for (const phase of ['before', 'complete', 'rollback'] as const) for (const kind of ['link', 'file'] as const) {
  test(`${phase} refuses a ${kind} at an owned namespace ancestor`, () => {
    const w = world(), s = phase === 'before' ? undefined : snapshot(w);
    mkdirSync(join(w.claudeHome, 'plugins'), { recursive: true });
    const ancestor = join(w.claudeHome, 'plugins', 'cache');
    if (kind === 'link') symlinkSync(w.codexHome, ancestor);
    else writeFileSync(ancestor, 'KEEP');
    const run = () => phase === 'before' ? snapshot(w) : phase === 'complete' ? completeLedger(s!) : rollbackSnapshot(s!, {});
    assert.throws(run, /linked|not a directory|ENOTDIR/);
    if (kind === 'file') assert.equal(readFileSync(ancestor, 'utf8'), 'KEEP');
    assert.deepEqual(tree(w.codexHome), {});
  });
}

test('complete refuses an unsafe new file inside an owned namespace', () => {
  const w = world(), owned = join(w.claudeHome, 'plugins', 'cache', 'context-engine');
  mkdirSync(owned, { recursive: true });
  const s = snapshot(w), external = join(w.codexHome, 'keep.txt');
  writeFileSync(external, 'EXTERNAL');
  symlinkSync(external, join(owned, 'unsafe'));
  assert.throws(() => completeLedger(s), /linked/);
  assert.equal(readFileSync(external, 'utf8'), 'EXTERNAL');
  assert.equal(existsSync(join(s.dir, 'ledger.json')), false);
});

test('legacy pending snapshots retain full traversal when the current spec uses namespaced mode', () => {
  const w = world(), s = snapshot(w, 'full'), ctx = setupContext(w.env), spec = claudeSpec(ctx);
  delete s.inventoryMode;
  writeFileSync(join(ctx.setupDir, 'claude.pending.json'), JSON.stringify(s), { mode: 0o600 });
  const pending = interruptedInstall(ctx, spec)!;
  assert.equal(pending.inventoryMode, undefined);
  unrelatedPlugins(w.claudeHome);
  assert.throws(() => completeLedger(pending), INVENTORY);
  assert.throws(() => rollbackSnapshot(pending, spec.rules), INVENTORY);
});

test('unknown and mismatched pending inventory modes refuse before changes', () => {
  const w = world(), s = snapshot(w), ctx = setupContext(w.env), spec = claudeSpec(ctx);
  assert.equal(s.inventoryMode, 'namespaced');
  const pending = join(ctx.setupDir, 'claude.pending.json');
  for (const inventoryMode of ['unknown', 'full', null]) {
    writeFileSync(pending, JSON.stringify({ ...s, inventoryMode }), { mode: 0o600 });
    assert.throws(() => interruptedInstall(ctx, spec), /confinement policy/);
  }
  writeFileSync(pending, JSON.stringify(s));
  assert.equal(interruptedInstall(ctx, spec)!.inventoryMode, 'namespaced');
  const bad = { ...s, inventoryMode: 'unknown' } as unknown as Snapshot;
  const before = tree(w.claudeHome), copies = tree(s.dir);
  assert.throws(() => completeLedger(bad), /unknown setup inventory mode/);
  assert.throws(() => rollbackSnapshot(bad, spec.rules), /unknown setup inventory mode/);
  assert.deepEqual(tree(w.claudeHome), before);
  assert.deepEqual(tree(s.dir), copies);
});

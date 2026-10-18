import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setParticipation } from '../core/index.ts';
import { tree, world, type World } from './testing/world.ts';

function fixture(): World {
  const w = world();
  mkdirSync(join(w.claudeHome, 'plugins'));
  writeFileSync(join(w.claudeHome, 'plugins', 'installed_plugins.json'), '{"version": 2, "plugins": {}}\n');
  writeFileSync(join(w.claudeHome, 'plugins', 'known_marketplaces.json'), '{}\n');
  return w;
}

function command(w: World, name: string, project = w.project) {
  const r = w.ce([name, '--project', project]);
  assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

function active(w: World, expected: boolean, project = w.project) {
  const status = JSON.parse(w.ce(['status', '--project', project, '--json']).stdout);
  const result = w.ce(['record', '--project', project, '--session', 'REINSTALL', '--runner', 'claude', '--hard-limit', '9000', '--if-enabled'], {
    input: JSON.stringify([{ role: 'user', text: 'REINSTALL_TASK' }]),
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.deepEqual({ status: status.claude.active, record: record.ok === true && record.active !== false }, { status: expected, record: expected });
}

test('[LIFE-018] install discloses retained opt-in; explicit disable keeps reinstall inactive', () => {
  const w = fixture();
  const siblingBefore = tree(w.codexHome);
  const installed = command(w, 'install');
  assert.match(installed, /Previously enabled projects.*can activate on install or reinstall/);
  assert.doesNotMatch(installed, /Inert until/);
  active(w, false);
  command(w, 'enable');
  active(w, true);
  const participationBefore = tree(join(w.stateDir, 'participation'));
  assert.match(command(w, 'uninstall'), /Shared participation is retained/);
  command(w, 'install');
  assert.deepEqual(tree(join(w.stateDir, 'participation')), participationBefore);
  active(w, true);
  command(w, 'disable');
  active(w, false);
  command(w, 'uninstall');
  command(w, 'install');
  active(w, false);
  assert.deepEqual(tree(w.codexHome), siblingBefore, 'Claude setup must not change sibling configuration');
});

test('[LIFE-018] shared ancestor opt-in survives install while a disabled child remains off', () => {
  const w = fixture();
  const child = join(w.project, 'child');
  mkdirSync(child);
  // A shared record has no runner identity: another adapter can write the same opt-in.
  setParticipation({ projectRoot: w.project, stateDir: w.stateDir, state: 'on' });
  const participationBefore = tree(join(w.stateDir, 'participation'));
  command(w, 'install');
  assert.deepEqual(tree(join(w.stateDir, 'participation')), participationBefore);
  active(w, true, child);
  command(w, 'disable', child);
  const disabledBefore = tree(join(w.stateDir, 'participation'));
  command(w, 'uninstall');
  command(w, 'install');
  assert.deepEqual(tree(join(w.stateDir, 'participation')), disabledBefore);
  active(w, false, child);
  active(w, true);
});

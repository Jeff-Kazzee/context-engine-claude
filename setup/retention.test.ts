import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[LIFE-005] Claude uninstall keeps an enabled project\'s records byte for byte', () => {
  const w = world();
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const session = ['--session', 'KEEP', '--runner', 'claude', '--hard-limit', '9000', '--if-enabled'];
  const record = w.ce(['record', ...session], { input: JSON.stringify([{ role: 'user', text: 'RETAINED_TASK' }]) });
  assert.equal(record.status, 0, record.stdout + record.stderr);
  const file = join(w.project, '.context-engine', 'KEEP', 'context.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}RETAINED_EDIT\n`);
  const sync = w.ce(['sync', ...session]);
  assert.equal(JSON.parse(sync.stdout).receipt.kind, 'committed', sync.stdout + sync.stderr);
  assert.equal(w.ce(['close', '--session', 'KEEP']).status, 0);

  const records = () => Object.fromEntries(Object.entries(tree(w.stateDir)).filter(([path]) => !path.startsWith('setup/')));
  const state = records(), project = tree(join(w.project, '.context-engine'));
  assert.ok(Object.keys(state).some((path) => path.endsWith('/KEEP/events.jsonl')), 'Event Log present');
  assert.ok(Object.keys(state).some((path) => path.includes('/KEEP/revisions/')), 'revisions present');
  assert.ok(Object.keys(state).some((path) => path.startsWith('participation/') && path.endsWith('.json')), 'participation record present');

  const un = w.ce(['uninstall']);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(records(), state);
  assert.deepEqual(tree(join(w.project, '.context-engine')), project);
  assert.equal(JSON.parse(w.ce(['status', '--json']).stdout).participation.state, 'on');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[LIFE-002] Claude uninstall with no install record changes nothing', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), '{"theme": "dark"}\n');
  const home = tree(w.claudeHome), project = tree(w.project);
  const r = w.ce(['uninstall']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /not installed by Context Engine/);
  assert.deepEqual(tree(w.claudeHome), home);
  assert.deepEqual(tree(w.project), project);
  // The setup lock needs its private directory. Nothing else is written there.
  assert.deepEqual(Object.entries(tree(w.stateDir)).filter(([, kind]) => kind !== 'dir'), []);
});

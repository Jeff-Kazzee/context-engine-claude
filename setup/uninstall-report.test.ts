import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

const SETTINGS = '{"theme": "dark",\n  "env": {"FOO": "1"}}\n';

test('[LIFE-004] reverse-edit report names an existing before-backup', () => {
  const w = world();
  const path = join(w.claudeHome, 'settings.json');
  writeFileSync(path, SETTINGS);
  assert.equal(w.ce(['install']).status, 0);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  settings.model = 'opus';
  writeFileSync(path, JSON.stringify(settings, null, 2));

  const un = w.ce(['uninstall']);
  assert.equal(un.status, 0, un.stderr);
  const backup = /settings\.json: changed by something else since install.*the original is at (\/[^)]+)\)$/m.exec(un.stdout)?.[1];
  assert.ok(backup, un.stdout);
  assert.equal(readFileSync(backup, 'utf8'), SETTINGS);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { env: { FOO: '1' }, model: 'opus', theme: 'dark' });
});

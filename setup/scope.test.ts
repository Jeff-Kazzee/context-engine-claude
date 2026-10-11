import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

test('[LIFE-006] Claude CLI enable covers a child and child disable overrides it', () => {
  const w = world();
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const child = join(w.project, 'child');
  mkdirSync(child);
  const status = (dir: string) => JSON.parse(w.ce(['status', '--project', dir, '--json']).stdout);

  const inherited = status(child);
  assert.equal(inherited.participation.state, 'on');
  assert.equal(inherited.participation.project, realpathSync(w.project));
  assert.equal(inherited.claude.active, true);

  const disabled = w.ce(['disable', '--project', child]);
  assert.equal(disabled.status, 0, disabled.stderr);
  const off = status(child);
  assert.equal(off.participation.state, 'off');
  assert.equal(off.participation.project, realpathSync(child));
  assert.equal(off.claude.active, false);
  const parent = status(w.project);
  assert.equal(parent.participation.state, 'on');
  assert.equal(parent.claude.active, true);
});

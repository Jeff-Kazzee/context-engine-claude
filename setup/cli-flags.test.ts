import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[CLI-007] Claude CLI refuses --trust-hooks and honours --project', () => {
  const w = world();
  const homes = () => [tree(w.claudeHome), tree(w.codexHome)];
  const empty = homes();
  for (const flag of ['--trust-hooks', '--codex']) {
    const refused = w.ce(['install', flag]);
    assert.equal(refused.status, 1, flag);
    assert.match(refused.stderr, /supports claude only/);
    assert.deepEqual(homes(), empty, `${flag} changed a runner home`);
    assert.equal(existsSync(join(w.stateDir, 'setup')), false, `${flag} created setup state`);
  }

  assert.equal(w.ce(['install']).status, 0);
  const sub = join(w.project, 'sub');
  mkdirSync(sub);
  const enabled = w.ce(['enable', '--project', sub]);
  assert.equal(enabled.status, 0, enabled.stderr);
  const child = JSON.parse(w.ce(['status', '--project', sub, '--json']).stdout);
  assert.equal(child.project, realpathSync(sub));
  assert.equal(child.participation.state, 'on');
  assert.equal(child.participation.project, realpathSync(sub));
  assert.equal(JSON.parse(w.ce(['status', '--json']).stdout).participation.state, 'default', 'the cwd project was not enabled');
});

test('[CLI-007] unknown flag fails without state change', () => {
  const w = world();
  const r = w.ce(['install', '--bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--bogus/);
  assert.equal(existsSync(join(w.stateDir, 'setup')), false);
  assert.deepEqual(tree(w.claudeHome), {});
});

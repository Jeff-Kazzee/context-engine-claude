import test from 'node:test';
import assert from 'node:assert/strict';
import { participation } from '../core/index.ts';
import { TURN_MODE } from '../adapters/claude/context-engine/hooks/adapter.ts';
import { world } from './testing/world.ts';

test('[CLI-009] Claude status text names mode, reason and the unverified hook-loading caveat', () => {
  const w = world();
  assert.equal(w.ce(['install']).status, 0);
  assert.equal(w.ce(['enable']).status, 0);
  const active = w.ce(['status']);
  assert.equal(active.status, 0, active.stderr);
  const lines = active.stdout.split('\n');
  assert.ok(lines.includes(`Delivery Mode: ${TURN_MODE.describe()}`), active.stdout);
  assert.ok(lines.includes('Configured active here; interactive hook loading is unverified.'), active.stdout);
  const json = JSON.parse(w.ce(['status', '--json']).stdout);
  assert.equal(json.claude.active, true);
  assert.equal(json.claude.mode, TURN_MODE.describe());
  assert.equal(json.claude.liveLoadingVerified, false);

  assert.equal(w.ce(['disable']).status, 0);
  const inactive = w.ce(['status']);
  const { reason } = participation({ projectRoot: w.project, stateDir: w.stateDir, env: {} });
  assert.match(reason, /^disabled for /);
  assert.ok(inactive.stdout.split('\n').includes(`inactive here (${reason})`), inactive.stdout);
  assert.equal(JSON.parse(w.ce(['status', '--json']).stdout).claude.active, false);
});

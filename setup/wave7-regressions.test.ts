import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setupContext } from './runners.ts';
import { tempDir } from '../core/testing.ts';

test('wave7: supplied setup environment isolates CE, XDG and HOME roots', () => {
  const home = tempDir('supplied-home');
  const ambient = process.env.CONTEXT_ENGINE_STATE_DIR;
  process.env.CONTEXT_ENGINE_STATE_DIR = join(home, 'ambient');
  try {
    assert.equal(setupContext({ HOME: home, CONTEXT_ENGINE_STATE_DIR: join(home, 'explicit') }).setupDir, join(home, 'explicit', 'setup'));
    assert.equal(setupContext({ HOME: home, XDG_STATE_HOME: join(home, 'xdg') }).setupDir, join(home, 'xdg', 'context-engine', 'setup'));
    assert.equal(setupContext({ HOME: home }).setupDir, join(home, '.local', 'state', 'context-engine', 'setup'));
    assert.throws(() => setupContext({ HOME: home, CONTEXT_ENGINE_STATE_DIR: 'relative' }), /absolute/);
    assert.equal(setupContext().setupDir, join(home, 'ambient', 'setup'));
  } finally {
    if (ambient === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR;
    else process.env.CONTEXT_ENGINE_STATE_DIR = ambient;
  }
});

import { enableProject, disableProject } from './project.ts';
import { findRecord } from '../core/participation.ts';
import { statusText } from './status.ts';
import { world } from './testing/world.ts';

test('wave7: context participation and status stay in the supplied state root', async () => {
  const w = world(), ctx = setupContext(w.env);
  const ambient = process.env.CONTEXT_ENGINE_STATE_DIR;
  process.env.CONTEXT_ENGINE_STATE_DIR = join(tempDir('ambient-state'), 'context-engine');
  try {
  enableProject(ctx, w.project);
  assert.equal(findRecord({ projectRoot: w.project, stateDir: w.stateDir })?.state, 'on');
  assert.equal(findRecord({ projectRoot: w.project }), null, 'ambient scratch root has no record');
  const status = await statusText(ctx, w.project);
  assert.equal((status.json.participation as { state: string }).state, 'on');
  disableProject(ctx, w.project);
  assert.equal(findRecord({ projectRoot: w.project, stateDir: w.stateDir })?.state, 'off');
  } finally {
    if (ambient === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR;
    else process.env.CONTEXT_ENGINE_STATE_DIR = ambient;
  }
});

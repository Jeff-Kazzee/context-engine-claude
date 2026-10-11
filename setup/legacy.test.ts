import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tempDir } from '../core/testing.ts';
import { tree, world } from './testing/world.ts';

/** Core 0.1.0 keyed state by `<basename>-<first 8 hex of sha256(realpath)>` (context-engine ac87e44, core/store.ts). */
const legacyKey = (dir: string) => `${basename(dir).replace(/[^\w.-]/g, '_') || 'root'}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;

test('[LIFE-014] legacy 0.1.0 state is ignored and preserved', () => {
  const w = world();
  const legacy = realpathSync(tempDir('legacy-project'));
  const key = legacyKey(legacy);
  const seed = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  };
  seed(join(w.stateDir, 'participation', `${key}.json`), `${JSON.stringify({ projectRoot: legacy, state: 'on', at: '2026-01-01T00:00:00.000Z' })}\n`);
  seed(join(w.stateDir, key, 'S1', 'events.jsonl'), '{"seq":1,"kind":"legacy"}\n');
  seed(join(w.stateDir, 'setup', 'backups', `claude-20260101T000000Z`, 'before', '0-settings.json'), '{"theme": "legacy"}\n');
  const seeded = tree(w.stateDir);

  assert.equal(w.ce(['install']).status, 0);
  const status = JSON.parse(w.ce(['status', '--project', legacy, '--json']).stdout);
  assert.equal(status.participation.state, 'default', 'a 0.1.0 record never enables a project');
  assert.equal(status.claude.active, false);
  assert.equal(w.ce(['enable']).status, 0);
  assert.equal(w.ce(['uninstall']).status, 0);

  const now = tree(w.stateDir);
  for (const [path, digest] of Object.entries(seeded)) assert.equal(now[path], digest, `${path} kept byte for byte`);
});

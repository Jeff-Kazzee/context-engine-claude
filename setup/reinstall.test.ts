import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

test('[LIFE-018] Claude reinstall stays inactive in a previously enabled project', {
  todo: 'routed: the Claude adapter gates only on shared core participation (adapters/claude/context-engine/hooks/adapter.ts and core --if-enabled), so setup has no Claude-only opt-in to retire at uninstall',
}, () => {
  const w = world();
  // Existing registries are restored byte for byte. Absent ones come back as {"version": 2}, which the fake runner cannot reinstall over.
  mkdirSync(join(w.claudeHome, 'plugins'));
  writeFileSync(join(w.claudeHome, 'plugins', 'installed_plugins.json'), '{"version": 2, "plugins": {}}\n');
  writeFileSync(join(w.claudeHome, 'plugins', 'known_marketplaces.json'), '{}\n');
  for (const command of ['install', 'enable', 'uninstall', 'install']) {
    const r = w.ce([command]);
    assert.equal(r.status, 0, `${command}: ${r.stdout}${r.stderr}`);
  }
  const active = () => {
    const status = JSON.parse(w.ce(['status', '--json']).stdout);
    const record = JSON.parse(w.ce(['record', '--session', 'REINSTALL', '--runner', 'claude', '--hard-limit', '9000', '--if-enabled'], { input: JSON.stringify([{ role: 'user', text: 'REINSTALL_TASK' }]) }).stdout);
    return { status: status.claude.active, record: record.ok === true && record.active !== false };
  };
  assert.deepEqual(active(), { status: false, record: false }, 'install printed "Inert until enable", so the earlier opt-in must not reactivate Claude');
  assert.equal(w.ce(['enable']).status, 0);
  assert.deepEqual(active(), { status: true, record: true });
});

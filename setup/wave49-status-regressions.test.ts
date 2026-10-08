import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './testing/world.ts';

for (const plugin of ['context-engine@context-engine', 'context-engine-trigger@context-engine']) {
  for (const value of [undefined, null, 17, 'checkout-relative', 'relative/core/cli.ts', '/missing/core/cli.ts']) {
    test(`status refuses active when ${plugin} has unusable coreCli ${String(value)}`, () => {
      const w = world();
      const install = w.ce(['install']);
      assert.equal(install.status, 0, install.stderr);
      assert.equal(w.ce(['enable']).status, 0);
      const before = w.ce(['status', '--json']);
      assert.equal(JSON.parse(before.stdout).claude.active, true, before.stdout + before.stderr);
      const path = join(w.claudeHome, 'settings.json');
      const settings = JSON.parse(readFileSync(path, 'utf8'));
      settings.pluginConfigs[plugin].options.coreCli = value;
      writeFileSync(path, JSON.stringify(settings));
      const after = w.ce(['status', '--json']);
      assert.equal(after.status, 0, after.stderr);
      assert.equal(JSON.parse(after.stdout).claude.active, false);
    });
  }
}

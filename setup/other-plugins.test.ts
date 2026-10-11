import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tree, world } from './testing/world.ts';

test('[LIFE-008] Claude uninstall keeps another plugin registration', () => {
  const w = world();
  const plugins = join(w.claudeHome, 'plugins');
  const cache = join(plugins, 'cache', 'mkt', 'other', '1.0.0');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'plugin.json'), '{"name": "other", "version": "1.0.0"}\n');
  const seeded = {
    [join(w.claudeHome, 'settings.json')]: '{\n  "enabledPlugins": {"other@mkt": true},\n  "extraKnownMarketplaces": {"mkt": {"source": {"source": "directory", "path": "/opt/mkt"}}},\n  "pluginConfigs": {"other@mkt": {"options": {"level": "2"}}},\n  "theme": "dark"\n}\n',
    [join(plugins, 'installed_plugins.json')]: `{"version": 2, "plugins": {"other@mkt": [{"scope": "user", "installPath": ${JSON.stringify(cache)}, "version": "1.0.0"}]}}\n`,
    [join(plugins, 'known_marketplaces.json')]: '{"mkt": {"source": {"source": "directory", "path": "/opt/mkt"}, "installLocation": "/opt/mkt"}}\n',
  };
  for (const [path, text] of Object.entries(seeded)) writeFileSync(path, text);
  const otherCache = tree(join(plugins, 'cache', 'mkt'));

  for (const command of ['install', 'enable', 'disable', 'uninstall']) {
    const r = w.ce([command]);
    assert.equal(r.status, 0, `${command}: ${r.stdout}${r.stderr}`);
  }
  for (const [path, text] of Object.entries(seeded)) assert.equal(readFileSync(path, 'utf8'), text, path);
  assert.deepEqual(tree(join(plugins, 'cache', 'mkt')), otherCache);
});

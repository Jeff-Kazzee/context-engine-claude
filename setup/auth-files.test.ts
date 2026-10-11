import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { installLocked, uninstallLocked } from './install.ts';
import { claudeSpec, setupContext } from './runners.ts';
import { statusText } from './status.ts';
import { world } from './testing/world.ts';

const MARKER = 'SYNTHETIC_AUTH_MARKER';

/** Records every path setup opens or reads in this process, with descriptor-anchored names resolved. */
async function recordOpens(action: () => unknown): Promise<string[]> {
  const paths: string[] = [];
  const resolveAnchored = (path: unknown) => {
    const text = String(path);
    const anchored = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(text);
    if (!anchored) return text;
    try { return `${fs.readlinkSync(`/proc/self/fd/${anchored[1]}`)}${anchored[2] ?? ''}`; } catch { return text; }
  };
  const names = ['openSync', 'readFileSync', 'opendirSync', 'readdirSync', 'copyFileSync', 'cpSync', 'createReadStream'] as const;
  const natives = Object.fromEntries(names.map((name) => [name, (fs as any)[name]]));
  for (const name of names) (fs as any)[name] = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' || (path && typeof path === 'object' && !Buffer.isBuffer(path))) paths.push(resolveAnchored(path));
    return natives[name](path, ...rest);
  };
  syncBuiltinESMExports();
  try { await action(); return paths; }
  finally { for (const name of names) (fs as any)[name] = natives[name]; syncBuiltinESMExports(); }
}

const filesUnder = (root: string): string[] => fs.existsSync(root)
  ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
  : [];

test('[SAFE-010] Claude install, status and uninstall never open the credentials file', async () => {
  const w = world();
  const credentials = join(w.claudeHome, '.credentials.json');
  const account = join(w.claudeHome, '.claude.json');
  fs.writeFileSync(credentials, `{"claudeAiOauth": {"accessToken": "${MARKER}"}}\n`, { mode: 0o600 });
  fs.writeFileSync(account, `{"oauthAccount": {"emailAddress": "${MARKER}"}}\n`, { mode: 0o600 });
  fs.writeFileSync(join(w.claudeHome, 'settings.json'), '{"theme": "dark"}\n');
  const ctx = setupContext({ ...process.env, ...w.env });

  const paths = await recordOpens(() => {
    installLocked(ctx, claudeSpec(ctx));
    statusText(ctx, w.project);
    uninstallLocked(ctx, claudeSpec(ctx));
  });
  assert.ok(paths.some((p) => p === join(w.claudeHome, 'settings.json')), 'the spy saw setup read its tracked config');
  for (const secret of [credentials, account]) assert.equal(paths.includes(secret), false, `setup opened ${secret}`);
  for (const file of filesUnder(w.stateDir)) assert.equal(fs.readFileSync(file, 'utf8').includes(MARKER), false, `${file} holds credential bytes`);
});

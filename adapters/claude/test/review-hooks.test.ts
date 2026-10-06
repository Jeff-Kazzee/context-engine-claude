// Local Node stand-ins executing the real register module. This is not the
// installed runner's hook harness and does not establish host integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { parseArgs } from 'node:util';
import * as adapter from '../context-engine/hooks/adapter.ts';
import * as perStep from '../context-engine/hooks/per-step.ts';

function fixture(messages: adapter.ApiMessage[] = []) {
  const source = readFileSync(new URL('../context-engine/hooks/register.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace('export const register', 'const register');
  const load = new Function('adapterModule', 'stepModule', `const {${Object.keys(adapter).join(',')}} = adapterModule; const {${Object.keys(perStep).filter(k => !(k in adapter)).join(',')}} = stepModule; ${erased}; return register;`);
  const handlers = new Map<string, (...args: any[]) => any>();
  load(adapter, perStep)((name: string, ...args: any[]) => handlers.set(name, args.at(-1)), {});
  let nativeCalls = 0;
  const calls: string[] = [];
  const logs: string[] = [];
  const $ = {
    plugin: { root: '/checkout/adapters/claude/context-engine' },
    session: { id: async () => 'S1', root: async () => '/proj', usage: async () => ({}), messages: async () => messages },
    env: { get: async () => undefined },
    ui: { log: (s: string) => logs.push(s), status: () => {} },
    fs: { read: async () => 'current context' },
    process: { run: async (argv: string[]) => {
      const command = argv[2]!; calls.push(command);
      return command === 'record'
        ? { exitCode: 1, stdout: '{"ok":false,"error":"injected record failure"}', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ ok: true, revision: 1, chars: 15, workingContext: '/proj/.context-engine/S1/context.md', frameKey: '00112233445566778899aabbccddeeff' }), stderr: '' };
    } },
  };
  const compact = (trigger: string) => handlers.get('session.compact')!($, { trigger, messages: [] }, async () => { nativeCalls++; return { messages: [{ role: 'user', text: 'native summary' }] }; });
  return { compact, calls, logs, nativeCalls: () => nativeCalls };
}

test('post-open plugin core failure skips native compaction on repeated turns', async () => {
  const w = fixture();
  for (let i = 0; i < 2; i++) assert.match((await w.compact('plugin')).skip, /failed|unavailable/i);
  assert.equal(w.nativeCalls(), 0);
  assert.deepEqual(w.calls, ['open', 'record', 'record']);
});

for (const trigger of ['manual', 'auto']) test(`${trigger} core failure retains native fallback once`, async () => {
  const w = fixture();
  assert.equal((await w.compact(trigger)).messages[0].text, 'native summary');
  assert.equal(w.nativeCalls(), 1);
});

test('ambiguous frame compaction records nothing, stands aside and never invokes scheduled native compaction', async () => {
  const frame = adapter.compactionText('/proj/.context-engine/S1/context.md', 'old', [], undefined, '00112233445566778899aabbccddeeff');
  const row = (s: string) => ({ role: 'user' as const, content: [{ type: 'text', text: s }] });
  const w = fixture([row(frame), row('NEW_REQUIRED_SENTINEL'), row(frame)]);
  assert.match((await w.compact('plugin')).skip, /ambiguous/i);
  assert.match((await w.compact('plugin')).skip, /inactive/i);
  assert.deepEqual(w.calls, ['open']);
  assert.equal(w.nativeCalls(), 0);
});

test('successful setup output directs activation to the Claude-specific command', async () => {
  const source = readFileSync(new URL('../../../setup/cli.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace('export async function runSetup', 'async function runSetup');
  let output = '', installs = 0;
  const deps = {
    parseArgs, SetupError: class extends Error {},
    setupContext: () => ({ env: {}, claudeHome: '/synthetic' }),
    claudeSpec: () => ({ id: 'claude', title: 'Claude Code' }),
    claudeModeLabel: () => adapter.TURN_MODE.label,
    install: (_ctx: unknown, spec: { id: string }) => { assert.equal(spec.id, 'claude'); installs++; return []; },
    uninstall: () => { throw new Error('unexpected uninstall'); },
    enableProject: () => { throw new Error('unexpected enable'); },
    disableProject: () => { throw new Error('unexpected disable'); },
    statusText: () => { throw new Error('unexpected status'); },
  };
  const proc = { cwd: () => '/synthetic', stdout: { write: (s: string) => { output += s; } }, stderr: { write: (s: string) => { throw new Error(s); } } };
  const run = new Function('deps', 'process', `const {${Object.keys(deps).join(',')}} = deps; ${erased}; return runSetup;`)(deps, proc);
  assert.equal(await run(['install']), 0);
  assert.equal(installs, 1);
  assert.match(output, /`context-engine-claude enable`/);
  assert.doesNotMatch(output, /`context-engine enable`/);
});

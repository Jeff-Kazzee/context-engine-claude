// Local Node stand-ins executing the real register module. This is not the
// installed runner's hook harness and does not establish host integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { parseArgs } from 'node:util';
import * as adapter from '../context-engine/hooks/adapter.ts';
import * as perStep from '../context-engine/hooks/per-step.ts';

function fixture(messages: adapter.ApiMessage[] = [], opts: { mode?: string; file?: string; budget?: string; inactive?: boolean; failClose?: boolean } = {}) {
  const source = readFileSync(new URL('../context-engine/hooks/register.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace('export const register', 'const register');
  const load = new Function('adapterModule', 'stepModule', `const {${Object.keys(adapter).join(',')}} = adapterModule; const {${Object.keys(perStep).filter(k => !(k in adapter)).join(',')}} = stepModule; ${erased}; return register;`);
  const handlers = new Map<string, (...args: any[]) => any>();
  load(adapter, perStep)((name: string, ...args: any[]) => handlers.set(name, args.at(-1)), {});
  let nativeCalls = 0;
  const calls: string[] = [];
  const argvCalls: string[][] = [];
  const logs: string[] = [];
  const statuses: Array<string | undefined> = [];
  const $ = {
    plugin: { root: '/checkout/adapters/claude/context-engine' },
    session: { id: async () => 'S1', root: async () => '/proj', usage: async () => ({}), messages: async () => messages, authorize: async () => { throw new Error('unexpected authorization'); } },
    env: { get: async (key: string) => key === 'CONTEXT_ENGINE_CLAUDE_MODE' ? opts.mode : key === 'CONTEXT_ENGINE_BUDGET_TOKENS' ? opts.budget : undefined },
    prompt: { compose: async () => ({ sections: [] }) }, tool: { list: async () => [] },
    ui: { log: (s: string) => logs.push(s), status: (s?: string) => statuses.push(s) },
    fs: { read: async () => opts.file ?? 'current context' },
    process: { run: async (argv: string[]) => {
      const command = argv[2]!; calls.push(command); argvCalls.push(argv);
      if (command === 'close' && opts.failClose) throw new Error('injected close failure');
      if ((command === 'record' || command === 'sync') && opts.inactive) return { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"disabled"}', stderr: '' };
      return command === 'record'
        ? { exitCode: 1, stdout: '{"ok":false,"error":"injected record failure"}', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ ok: true, revision: 1, chars: 15, workingContext: '/proj/.context-engine/S1/context.md', frameKey: '00112233445566778899aabbccddeeff' }), stderr: '' };
    } },
  };
  const compact = (trigger: string) => handlers.get('session.compact')!($, { trigger, messages: [] }, async () => { nativeCalls++; return { messages: [{ role: 'user', text: 'native summary' }] }; });
  const tool = (e: any) => handlers.get('tool.call')!($, e, async (v: any) => v);
  const append = (e: any) => handlers.get('session.append')!($, e, async (v: any) => v);
  const end = () => handlers.get('session.end')!($, {}, async () => ({}));
  const step = async () => {
    await handlers.get('session.start')!($, {}, async () => ({}));
    const stream = handlers.get('turn.step')!($, { model: 'synthetic', turnId: 't', index: 1 }, async function* () { nativeCalls++; return {}; });
    for await (const _ of stream) { /* No real model is called. */ }
  };
  return { compact, tool, append, end, step, calls, argvCalls, logs, statuses, nativeCalls: () => nativeCalls };
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
  assert.deepEqual(w.calls, ['open', 'close']);
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

test('shell edits preserve a same-turn read while ordinary duplicate reads are stubbed', async () => {
  const w = fixture();
  await w.compact('plugin');
  const read = { tool: 'Read', file_path: '/proj/.context-engine/S1/context.md', tool_use_id: 'r1' };
  const result = { message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'EDITED_CONTEXT_SENTINEL' }] } };
  await w.tool(read);
  assert.ok(!JSON.stringify(await w.append(result)).includes('EDITED_CONTEXT_SENTINEL'));
  await w.tool({ tool: 'Bash', command: 'synthetic shell edit', tool_use_id: 'b1' });
  await w.tool({ ...read, tool_use_id: 'r2' });
  assert.match(JSON.stringify(await w.append({ message: { content: [{ ...result.message.content[0], tool_use_id: 'r2' }] } })), /EDITED_CONTEXT_SENTINEL/);
});

for (const trigger of ['plugin', 'manual', 'auto']) test(`inactive ${trigger} compaction closes once before end`, async () => {
  const w = fixture([], { inactive: true });
  await w.compact(trigger);
  await w.end();
  assert.deepEqual(w.calls, ['open', 'record', 'close']);
  assert.equal(w.nativeCalls(), trigger === 'plugin' ? 0 : 1);
});

test('stand-aside retains a failed close handle for end cleanup', async () => {
  const frame = adapter.compactionText('/proj/.context-engine/S1/context.md', 'old', [], undefined, '00112233445566778899aabbccddeeff');
  const row = (text: string) => ({ role: 'user' as const, content: [{ type: 'text', text }] });
  const w = fixture([row(frame), row(frame)], { failClose: true });
  await w.compact('plugin');
  await w.end();
  assert.deepEqual(w.calls, ['open', 'close', 'close']);
  assert.equal(w.nativeCalls(), 0);
});

for (const opts of [{ budget: '40000', file: 'x'.repeat(80001) }, { budget: '1', file: 'x' }, { file: 'x'.repeat(600001) }]) test(`per-step refuses oversized file before auth/request (${opts.budget ?? 'hard limit'})`, async () => {
  const w = fixture([], { ...opts, mode: 'per-step' });
  await w.step();
  assert.equal(w.nativeCalls(), 1);
  assert.match(w.logs.join('\n'), /budget|hard limit/);
  const sync = w.argvCalls.find(argv => argv[2] === 'sync')!;
  if (opts.budget === '40000') assert.ok(sync.includes('--budget'));
});

test('Claude status checks the runtime-specific CLI rather than the sibling generic alias', () => {
  const source = readFileSync(new URL('../../../setup/status.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replaceAll('export function', 'function');
  const deps = { join, delimiter, existsSync, killSwitchOn: () => false, participation: () => ({ state: 'off', active: false }), installedLedger: () => null, safeRead: () => null, CLAUDE_PLUGIN_IDS: [], TURN_MODE: adapter.TURN_MODE, PER_STEP_MODE: adapter.PER_STEP_MODE, MODE_ENV: 'MODE', perStepOn: () => false };
  const status = new Function('deps', `const {${Object.keys(deps).join(',')}} = deps; ${erased}; return statusText;`)(deps);
  const root = mkdtempSync(join(tmpdir(), 'ce-cli-status-'));
  try {
    const ctx = { env: { PATH: root }, claudeHome: root, checkout: '/synthetic' };
    writeFileSync(join(root, 'context-engine'), 'synthetic sibling alias');
    assert.ok(status(ctx, root).lines.includes('CLI on PATH: false'));
    rmSync(join(root, 'context-engine'));
    writeFileSync(join(root, 'context-engine-claude'), 'synthetic Claude alias');
    assert.ok(status(ctx, root).lines.includes('CLI on PATH: true'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('inactive per-step sync closes once and clears status before native delivery', async () => {
  const w = fixture([], { mode: 'per-step', inactive: true });
  await w.step();
  await w.end();
  assert.deepEqual(w.calls, ['open', 'sync', 'close']);
  assert.equal(w.nativeCalls(), 1);
  assert.ok(w.statuses.some(s => s?.includes('EXPERIMENTAL')));
  assert.equal(w.statuses.at(-1), undefined);
});

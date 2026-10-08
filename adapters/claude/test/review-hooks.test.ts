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

function fixture(messages: adapter.ApiMessage[] = [], opts: { response?: string; missingFrameKey?: boolean; refusedRecord?: boolean; sessionId?: string; nativeOverBudget?: boolean; mode?: string; file?: string; budget?: string; inactive?: boolean; failClose?: boolean; revision?: number; syncRevision?: number; failSync?: boolean; restored?: boolean; recordSuccess?: boolean; recordChars?: number; onCommand?: (command: string) => void; onSnapshot?: () => void; onAuthorize?: () => void; noAuth?: boolean; failNative?: boolean; failSnapshot?: boolean; failAuthorize?: boolean; onNative?: () => Promise<void> } = {}) {
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
    http: {fetch: async (_url: string, init: any) => { assert.equal(init.auth,'synthetic-opaque-handle'); return {status:200,text:opts.response}; }},
    plugin: { root: '/checkout/adapters/claude/context-engine' },
    session: { id: async () => opts.sessionId ?? 'S1', root: async () => '/proj', usage: async () => ({}), messages: async () => messages, authorize: async () => { opts.onAuthorize?.(); if (opts.failAuthorize) throw new Error('synthetic authorization fault'); if (opts.noAuth) return null; if (opts.response !== undefined) return {handle:'synthetic-opaque-handle',kind:'bearer'}; throw new Error('unexpected authorization'); } },
    env: { get: async (key: string) => key === 'CONTEXT_ENGINE_CLAUDE_MODE' ? opts.mode : key === 'CONTEXT_ENGINE_BUDGET_TOKENS' ? opts.budget : undefined },
    prompt: { compose: async () => ({ sections: [] }) }, tool: { list: async () => [] },
    ui: { log: (s: string) => logs.push(s), status: (s?: string) => statuses.push(s) },
    fs: { read: async () => { throw new Error('live Working Context reread is forbidden in this fixture'); } },
    process: { run: async (argv: string[]) => {
      const command = argv[2]!; calls.push(command); argvCalls.push(argv); opts.onCommand?.(command);
      if (command === 'sync' && opts.failSync) throw new Error('synthetic observation failure');
      if (command === 'close' && opts.failClose) throw new Error('injected close failure');
      if ((command === 'record' || command === 'sync') && opts.inactive) return { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"disabled"}', stderr: '' };
      const snapshot = opts.file ?? 'current context'; if (['sync', 'record', 'native-compaction'].includes(command)) opts.onSnapshot?.();
      if(command==='record' && opts.refusedRecord)return {exitCode:2,stdout:'{"ok":false,"error":"refused"}',stderr:''};
      return command === 'record' && !opts.recordSuccess
        ? { exitCode: 1, stdout: '{"ok":false,"error":"injected record failure"}', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ ok: true, budget: command === 'native-compaction' && opts.nativeOverBudget ? {overBudget:true,approxTokens:4,budgetTokens:1,text:'SYNTHETIC_OVER_BUDGET'} : undefined, workingContextText: opts.failSnapshot ? undefined : snapshot, revision: command === 'sync' ? opts.syncRevision ?? opts.revision ?? 1 : opts.revision ?? 1, receipt: command === 'sync' && opts.restored ? { kind: 'restored', revision: 1, chars: 15, approxTokens: 4, text: 'synthetic restored receipt' } : undefined, chars: command === 'record' ? opts.recordChars ?? 15 : 15, workingContext: '/proj/.context-engine/S1/context.md', frameKey: opts.missingFrameKey ? undefined : '00112233445566778899aabbccddeeff' }), stderr: '' };
    } },
  };
  const compact = (trigger: string) => handlers.get('session.compact')!($, { trigger, messages: [] }, async () => { nativeCalls++; if (opts.failNative) throw new Error('synthetic native failure'); return { messages: [{ role: 'user', text: 'native summary' }] }; });
  const tool = (e: any) => handlers.get('tool.call')!($, e, async (v: any) => v);
  const append = (e: any) => handlers.get('session.append')!($, e, async (v: any) => v);
  const end = () => handlers.get('session.end')!($, {}, async () => ({}));
  const step = async () => {
    await handlers.get('session.start')!($, {}, async () => ({}));
    const stream = handlers.get('turn.step')!($, { model: 'synthetic', turnId: 't', index: 1 }, async function* () { nativeCalls++; await opts.onNative?.(); return {}; });
    for await (const _ of stream) { /* No real model is called. */ }
  };
  return { $, handlers, compact, tool, append, end, step, calls, argvCalls, logs, statuses, nativeCalls: () => nativeCalls };
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
    realpathSync: (path: string) => path, resolve: (path: string) => path, join,
    acquireSetupLock: () => () => {},
    setupContext: () => ({ env: {}, claudeHome: '/synthetic', setupDir: '/synthetic-state' }),
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
  const deps = { join, delimiter, existsSync, dirname: (path: string) => path.slice(0,path.lastIndexOf('/')), openPrivateDirectory: () => undefined, closeSync: () => {}, killSwitchOn: () => false, participation: () => ({ state: 'off', active: false }), installedLedger: () => null, safeRead: () => null, CLAUDE_PLUGIN_IDS: [], TURN_MODE: adapter.TURN_MODE, PER_STEP_MODE: adapter.PER_STEP_MODE, MODE_ENV: 'MODE', perStepOn: () => false };
  const status = new Function('deps', `const {${Object.keys(deps).join(',')}} = deps; ${erased}; return statusText;`)(deps);
  const root = mkdtempSync(join(tmpdir(), 'ce-cli-status-'));
  try {
    const ctx = { env: { PATH: root }, claudeHome: root, checkout: '/synthetic', setupDir: root+'/setup' };
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

const shellRow: adapter.ApiMessage = { role: 'assistant', content: [{ type: 'tool_use', id: 'B', name: 'Bash', input: { command: 'opaque-script' } }] };
for (const trigger of ['plugin', 'manual', 'auto']) test(`unknown resumed Bash baseline stands aside (${trigger})`, async () => {
  const w = fixture([shellRow]);
  const result = await w.compact(trigger);
  assert.equal(w.calls.includes('record'), false);
  assert.equal(w.calls.filter(c => c === 'close').length, 1);
  assert.equal(w.nativeCalls(), trigger === 'plugin' ? 0 : 1);
  if (trigger === 'plugin') assert.match(result.skip, /ambiguous/);
});
test('failed Bash observation stands aside permanently before record', async () => {
  const w = fixture([shellRow], { failSync: true });
  await w.compact('plugin'); await w.compact('plugin');
  assert.deepEqual(w.calls, ['open', 'sync', 'close']);
});
test('a changed revision after a proven delivery refuses Bash record', async () => {
  const messages: adapter.ApiMessage[] = [];
  const opts = { recordSuccess: true, syncRevision: 1 };
  const w = fixture(messages, opts);
  await w.compact('plugin');
  messages.push(shellRow); opts.syncRevision = 2;
  await w.compact('plugin');
  assert.equal(w.calls.filter(c => c === 'record').length, 1);
  assert.equal(w.calls.filter(c => c === 'close').length, 1);
});
test('ordinary Bash output remains recorded after an unchanged proven delivery', async () => {
  const messages: adapter.ApiMessage[] = [];
  const w = fixture(messages, { recordSuccess: true });
  await w.compact('plugin'); messages.push(shellRow);
  await w.compact('plugin');
  assert.equal(w.calls.filter(c => c === 'record').length, 2);
  assert.equal(w.calls.includes('close'), false);
});

test('discarded compaction observation leaves budget reminders for the delivered record', async () => {
  const messages: adapter.ApiMessage[] = [];
  const w = fixture(messages, { recordSuccess: true, budget: '40000' });
  await w.compact('plugin'); messages.push(shellRow);
  await w.compact('plugin');
  const syncs = w.argvCalls.filter(argv => argv[2] === 'sync');
  assert.equal(syncs.length, 1, 'the shell observation must run');
  assert.equal(syncs[0]!.includes('--budget'), false, 'its discarded reply must not consume budget tiers');
  const records = w.argvCalls.filter(argv => argv[2] === 'record');
  assert.equal(records.length, 2);
  assert.ok(records.every(argv => argv.includes('--budget')), 'the delivered record retains its budget check');
});
test('restored Bash observation refuses even an unchanged delivered revision', async () => {
  const messages: adapter.ApiMessage[] = [];
  const w = fixture(messages, { recordSuccess: true, restored: true });
  await w.compact('plugin'); messages.push(shellRow);
  await w.compact('plugin');
  assert.equal(w.calls.filter(c => c === 'record').length, 1);
  assert.equal(w.calls.includes('close'), true);
});
test('an active root tool blocks observation and replacement and retains its result', async () => {
  const w = fixture(); await w.handlers.get('session.start')!(w.$, {}, async () => ({}));
  let finish!: (value: unknown) => void;
  const pending = w.handlers.get('tool.call')!(w.$, { tool: 'Bash' }, () => new Promise(resolve => { finish = resolve; }));
  await w.compact('plugin');
  assert.deepEqual(w.calls, ['open', 'close']);
  const original = { content: 'mixed ordinary output', is_error: true };
  finish(original); assert.equal(await pending, original);
});
test('failed Read remains an error through the actual append hook', async () => {
  const w = fixture(); await w.handlers.get('session.start')!(w.$, {}, async () => ({}));
  await w.tool({ tool: 'Read', file_path: '/proj/.context-engine/S1/context.md', tool_use_id: 'R' });
  const row = { message: { content: [{ type: 'tool_result', tool_use_id: 'R', is_error: true, content: 'synthetic missing file' }] } };
  assert.equal(await w.append(row), row);
});

for (const at of ['sync', 'snapshot', 'authorize']) test(`root tools starting during ${at} wait until replacement finishes`, async () => {
  let toolRan = false, pending: Promise<unknown> | undefined;
  const opts: Parameters<typeof fixture>[1] = { mode: 'per-step', noAuth: true };
  const w = fixture([], opts);
  const start = () => {
    pending ??= w.handlers.get('tool.call')!(w.$, { tool: 'Bash' }, async () => { toolRan = true; return 'original'; });
    assert.equal(toolRan, false, 'tool cannot mutate the observed Working Context');
  };
  if (at === 'sync') opts.onCommand = command => { if (command === 'sync') start(); };
  if (at === 'snapshot') opts.onSnapshot = start;
  if (at === 'authorize') opts.onAuthorize = start;
  await w.step();
  assert.ok(pending); assert.equal(await pending, 'original'); assert.equal(toolRan, true);
  assert.equal(w.nativeCalls(), 1);
});
for (const trigger of ['plugin', 'manual', 'auto']) test(`fallback read defers root tool and returns native-derived frame once (${trigger})`, async () => {
  let toolRan = false, pending: Promise<unknown> | undefined;
  const opts: Parameters<typeof fixture>[1] = { recordSuccess: true, recordChars: 600001 };
  const w = fixture([], opts);
  opts.onSnapshot = () => {
    pending = w.handlers.get('tool.call')!(w.$, { tool: 'Bash' }, async () => { toolRan = true; return 'original'; });
    assert.equal(toolRan, false);
  };
  const result = await w.compact(trigger);
  assert.ok(result.messages); assert.equal(w.nativeCalls(), 1);
  assert.equal(await pending, 'original'); assert.equal(toolRan, true);
});

for (const reentry of ['tool', 'compact']) test(`native per-step delegation releases lease before ${reentry} reentry`, { timeout: 3000 }, async () => {
  const opts: Parameters<typeof fixture>[1] = { mode: 'per-step', noAuth: true };
  const w = fixture([], opts);
  opts.onNative = async () => {
    if (reentry === 'tool') assert.equal(await w.tool({ tool: 'Read' }).then(() => 'done'), 'done');
    else await w.compact('plugin');
  };
  await w.step(); assert.equal(w.nativeCalls(), 1);
});

for (const trigger of ['plugin', 'manual', 'auto']) test(`post-record frame-read failure cannot replay tail (${trigger})`, async () => {
  const w = fixture([{ role: 'user', content: [{ type: 'text', text: 'ONCE_ONLY' }] }], { recordSuccess: true, failSnapshot: true });
  await w.compact(trigger); await w.compact(trigger);
  assert.equal(w.calls.filter(c => c === 'record').length, 1);
  assert.equal(w.calls.filter(c => c === 'close').length, 1);
  assert.equal(w.nativeCalls(), trigger === 'plugin' ? 0 : 2);
});
test('authorization rejection delegates native step and releases lease for tools', async () => {
  const opts: Parameters<typeof fixture>[1] = { mode: 'per-step', failAuthorize: true };
  const w = fixture([], opts); opts.onNative = async () => { await w.tool({ tool: 'Read' }); };
  await w.step(); assert.equal(w.nativeCalls(), 1); assert.ok(w.logs.some(s => s.includes('authorization failed')));
});

test('uncertain nonempty record outcome cannot replay the same transcript tail', async () => {
  const w = fixture([{ role: 'user', content: [{ type: 'text', text: 'DURABLY_COMMITTED_BUT_REPLY_LOST' }] }]);
  await w.compact('plugin'); await w.compact('plugin');
  assert.equal(w.calls.filter(c => c === 'record').length, 1);
  assert.equal(w.calls.filter(c => c === 'close').length, 1); assert.equal(w.nativeCalls(), 0);
});

test('native rejection after durable record stands aside without recording or invoking native twice', async () => {
  const w = fixture([{ role: 'user', content: [{ type: 'text', text: 'COMMIT_ONCE' }] }], { recordSuccess: true, recordChars: 600001, failNative: true });
  await assert.rejects(w.compact('plugin'), /synthetic native failure/);
  assert.match((await w.compact('plugin')).skip, /inactive/);
  assert.equal(w.calls.filter(c => c === 'record').length, 1);
  assert.equal(w.calls.filter(c => c === 'close').length, 1); assert.equal(w.nativeCalls(), 1);
});
test('missing fallback snapshot preserves produced native result and stands aside', async () => {
  const w = fixture([], { recordSuccess: true, recordChars: 600001, failSnapshot: true });
  assert.equal((await w.compact('manual')).messages[0].text, 'native summary');
  assert.match((await w.compact('plugin')).skip, /inactive/);
  assert.equal(w.calls.filter(c => c === 'record').length, 1); assert.equal(w.nativeCalls(), 1);
});

test('compaction uses the committed reply when the live file changes before delivery', async () => {
  const opts: Parameters<typeof fixture>[1] = { recordSuccess: true, file: 'COMMITTED_SNAPSHOT' };
  const w = fixture([], opts);
  opts.onSnapshot = () => { opts.file = 'UNCOMMITTED_OVERSIZED_OR_PRIVATE_CHANGE'; };
  const result = await w.compact('plugin');
  assert.match(result.messages[0].text, /COMMITTED_SNAPSHOT/);
  assert.doesNotMatch(result.messages[0].text, /UNCOMMITTED/);
});

test('renewed: session start clears edited-read state and stale tool IDs',async()=>{
 const w=fixture();await w.handlers.get('session.start')!(w.$,{},async()=>({}));
 const path='/proj/.context-engine/S1/context.md';
 await w.tool({tool:'Read',file_path:path,tool_use_id:'old'});
 await w.handlers.get('session.start')!(w.$,{},async()=>({}));
 const old={message:{content:[{type:'tool_result',tool_use_id:'old',content:'UNRELATED_REUSED_ID'}]}};
 assert.match(JSON.stringify(await w.append(old)),/UNRELATED_REUSED_ID/);
 await w.tool({tool:'Bash',command:'synthetic edit'});
 await w.handlers.get('session.start')!(w.$,{},async()=>({}));
 await w.tool({tool:'Read',file_path:path,tool_use_id:'new'});
 assert.doesNotMatch(JSON.stringify(await w.append({message:{content:[{type:'tool_result',tool_use_id:'new',content:'NEW_SESSION_DUPLICATE'}]}})),/NEW_SESSION_DUPLICATE/);
});

test('renewed6: a retained failed close survives later sessions and is retried',async()=>{
 const opts:Parameters<typeof fixture>[1]={sessionId:'S1',failClose:true};const w=fixture([],opts);
 await w.handlers.get('session.start')!(w.$,{},async()=>({}));await w.end();opts.sessionId='S2';
 await w.handlers.get('session.start')!(w.$,{},async()=>({}));await w.end();opts.failClose=false;await w.end();
 const closes=w.argvCalls.filter(args=>args.includes('close')).map(args=>args[args.indexOf('--session')+1]);
 assert.ok(closes.filter(id=>id==='S1').length>=2);assert.ok(closes.includes('S2'));assert.equal(closes.at(-2),'S1');assert.equal(closes.at(-1),'S2');
});
test('renewed6: over-budget native summary is returned without replacement framing',async()=>{
 const w=fixture([],{recordSuccess:true,recordChars:600001,budget:'1',nativeOverBudget:true});
 const r=await w.compact('manual');assert.equal(r.messages[0].text,'native summary');assert.equal(w.calls.filter(c=>c==='close').length,1);
});

for(const response of ['null','{"content":[null]}','{"content":[{"type":"text","text":3}]}','{"content":[],"stop_reason":{"toString":null}}'])test('wave16: malformed success delegates the next step once: '+response,async()=>{
  const w=fixture([],{mode:'per-step',response});await w.step();assert.equal(w.nativeCalls(),1);assert.match(w.logs.join('\n'),/failed.*native|failed.*sends this step/);await w.step();assert.equal(w.nativeCalls(),2);
});

for(const failClose of [false,true])test('wave29: successful open with missing frame key retains cleanup, failed close '+failClose,async()=>{
 const opts:Parameters<typeof fixture>[1]={missingFrameKey:true,failClose};const w=fixture([],opts);
 await w.compact('manual');assert.equal(w.calls.filter(c=>c==='close').length,1);
 opts.failClose=false;await w.end();assert.equal(w.calls.filter(c=>c==='close').length,failClose?2:1);
});
test('wave29: unmanaged native fallback stands aside before a later boundary',async()=>{
 const messages:adapter.ApiMessage[]=[];const w=fixture(messages);
 assert.equal((await w.compact('manual')).messages[0].text,'native summary');
 messages.push({role:'user',content:[{type:'text',text:'native summary'}]});
 assert.match((await w.compact('plugin')).skip,/inactive/);assert.equal(w.calls.filter(c=>c==='close').length,1);
 assert.equal(w.calls.filter(c=>c==='record').length,1);
});

test('wave29: refused empty-tail record native fallback stands aside before the next boundary',async()=>{
 const messages:adapter.ApiMessage[]=[];const w=fixture(messages,{refusedRecord:true});
 assert.equal((await w.compact('manual')).messages[0].text,'native summary');
 messages.push({role:'user',content:[{type:'text',text:'native summary'}]});
 assert.match((await w.compact('plugin')).skip,/inactive/);assert.equal(w.calls.filter(c=>c==='record').length,1);assert.equal(w.calls.filter(c=>c==='close').length,1);
});

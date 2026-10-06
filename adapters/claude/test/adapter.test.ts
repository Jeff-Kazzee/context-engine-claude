// Unit tests for the Claude Code Adapter's core-facing logic (pure functions, no Claude Code needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '../../../core/index.ts';
import { fixture } from '../../../core/testing.ts';
import { buildStepRequest } from '../context-engine/hooks/per-step.ts';
const { setParticipation } = core;
import {
  type ApiMessage,
  COMPACTION_ONLY_FALLBACK,
  CoreError,
  DEFAULT_PINNED_TOKENS,
  fallbackNotice,
  nativeEvents,
  workingContextBudget,
  TURN_RESERVE_FLOOR_TOKENS,
  PER_STEP_MODE,
  RECALL_GUIDANCE,
  STALE_REFS_GUIDANCE,
  TURN_MODE,
  deliveryMode,
  systemSectionText,
  HARD_LIMIT_CHARS,
  compactionText,
  coreArgv,
  eventsSinceLastFrame,
  checkLegacyFrame,
  parseCoreReply,
  stubWorkingContextReads,
} from '../context-engine/hooks/adapter.ts';

const WC = '/proj/.context-engine/S1/context.md';
const KEY = '00112233445566778899aabbccddeeff';

test('a fresh conversation preserves reminder and command-looking text without provenance', () => {
  const events = eventsSinceLastFrame(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nCLAUDE.md says hi\n</system-reminder>' },
          { type: 'text', text: 'FACT B: The codeword is SENTINEL_V1' },
        ],
      },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, { type: 'text', text: 'OK' }] },
      { role: 'user', content: [{ type: 'text', text: '<command-name>/compact</command-name>' }] },
    ],
    WC,
    KEY,
  );
  assert.deepEqual(
    events.map((e) => [e.role, e.text]),
    [
      ['user', '<system-reminder>\nCLAUDE.md says hi\n</system-reminder>\nFACT B: The codeword is SENTINEL_V1'],
      ['assistant', 'OK'],
      ['user', '<command-name>/compact</command-name>'],
    ],
  );
});

test('multiple keyed frames refuse an ambiguous recording boundary', () => {
  const frame = (body: string) => compactionText(WC, body, [], TURN_MODE.label, KEY);
  assert.throws(() => eventsSinceLastFrame(
    [
      { role: 'user', content: [{ type: 'text', text: frame('[[CTX_TURN 1 role=user]]\nold') }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nEnvironment\n</system-reminder>' },
          { type: 'text', text: frame('[[CTX_TURN 1 role=user]]\nnewer') },
          { type: 'text', text: 'Next question' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Next answer' }] },
    ],
    WC,
    KEY,
  ), /ambiguous.*frame/i);
});

test('tool calls are rendered whole, except on the Working Context file, whose own text is elided', () => {
  const events = eventsSinceLastFrame(
    [
      { role: 'user', content: [{ type: 'text', text: 'Edit your Working Context' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: WC } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/proj/src/a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'SENTINEL_DELETE_ME is in here' },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'export const a = 1' }] },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: WC, old_string: 'SENTINEL_DELETE_ME', new_string: '' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Error: string not found', is_error: true }] },
      { role: 'assistant', content: [{ type: 'image', source: {} }, { type: 'text', text: 'done' }] },
    ],
    WC,
    KEY,
  );
  assert.deepEqual(
    events.map((e) => [e.role, e.text]),
    [
      ['user', 'Edit your Working Context'],
      ['assistant', '[tool_use Read on the Working Context file: input elided]\n[tool_use Read] {"file_path":"/proj/src/a.ts"}'],
      ['user', '[tool_result Read on the Working Context file: elided]\n[tool_result Read] export const a = 1'],
      ['assistant', '[tool_use Edit on the Working Context file: input elided]'],
      ['user', '[tool_result Edit on the Working Context file: elided]'],
      ['assistant', '[image]\ndone'],
    ],
  );
  assert.ok(!JSON.stringify(events.map((e) => e.text)).includes('SENTINEL_DELETE_ME'));
  assert.equal(events[2]!.content.length, 2, 'the source blocks travel verbatim to the Event Log');
});

test('the echo of a Working Context Read is replaced by a stub; other results in the row are kept', () => {
  const content = [
    { type: 'tool_result', tool_use_id: 't1', content: '     1\t[[CTX_TURN 1 role=user]]\n     2\tSENTINEL_KEEP' },
    { type: 'tool_result', tool_use_id: 't2', content: 'other', is_error: true },
  ];
  const stubbed = stubWorkingContextReads(content, new Set(['t1']));
  assert.ok(stubbed);
  assert.equal(stubbed.length, 2);
  assert.match(String(stubbed[0]!.content), /^\(Read of the Working Context file:/);
  assert.ok(!String(stubbed[0]!.content).includes('SENTINEL_KEEP'));
  assert.deepEqual(stubbed[1], { type: 'tool_result', content: 'other', is_error: true });
  assert.equal(stubWorkingContextReads(content, new Set(['t9'])), null, 'nothing to stub: leave the row alone');
});

test('the core is called as node on the checkout\'s core/cli.ts, found from the plugin root', { skip: process.platform !== 'linux' && 'supported POSIX/Linux path contract' }, () => {
  const pluginRoot = fileURLToPath(new URL('../context-engine', import.meta.url));
  const argv = coreArgv(pluginRoot, 'open', { sessionId: 'S1', projectRoot: '/proj' });
  assert.equal(argv[0], 'node');
  assert.equal(argv[1], fileURLToPath(new URL('../../../core/cli.ts', import.meta.url)));
  assert.ok(existsSync(argv[1]!));
  assert.deepEqual(argv.slice(2), ['open', '--session', 'S1', '--project', '/proj', '--runner', 'claude-code', '--hard-limit', String(HARD_LIMIT_CHARS), '--if-enabled']);
});

test('core replies: ok JSON is returned, anything else is an error naming the cause', () => {
  const ok = parseCoreReply({ exitCode: 0, stdout: '{"ok":true,"revision":3,"chars":10,"turns":[],"workingContext":"/w"}\n', stderr: '' });
  assert.equal(ok.revision, 3);
  assert.equal(ok.workingContext, '/w');
  assert.throws(() => parseCoreReply({ exitCode: 1, stdout: '{"ok":false,"error":"boom"}\n', stderr: '' }), /boom/);
  assert.throws(
    () => parseCoreReply({ exitCode: 2, stdout: '{"ok":false,"error":"refused","holder":{"pid":42}}\n', stderr: '' }),
    (e: unknown) => e instanceof CoreError && e.refused && /refused/.test(e.message),
  );
  assert.throws(() => parseCoreReply({ exitCode: 1, stdout: '', stderr: 'node: not found' }), /node: not found/);
  assert.throws(
    () => parseCoreReply({ exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"not enabled for this project"}\n', stderr: '' }),
    (e: unknown) => e instanceof CoreError && e.inactive && !e.refused && /not enabled/.test(e.message),
  );
});

test('through the real core: in a project nobody enabled, or with the kill switch on, the core stands aside', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const f = fixture();
  const pluginRoot = fileURLToPath(new URL('../context-engine', import.meta.url));
  const open = (env: Record<string, string> = {}) => {
    const [, ...args] = coreArgv(pluginRoot, 'open', { sessionId: 'S1', projectRoot: f.projectRoot });
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, CONTEXT_ENGINE: '', CONTEXT_ENGINE_STATE_DIR: f.stateDir, ...env } });
    return () => parseCoreReply({ exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  };
  assert.throws(open(), (e: unknown) => e instanceof CoreError && e.inactive && /context-engine enable/.test(e.message));
  setParticipation({ ...f, state: 'on' });
  assert.throws(open({ CONTEXT_ENGINE: 'off' }), (e: unknown) => e instanceof CoreError && e.inactive && /CONTEXT_ENGINE=off/.test(e.message));
  assert.equal(open()().revision, 0);
});

test('through the real core: a mirrored turn comes back framed, a model edit replaces it, a deleted file is restored with a receipt', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  const pluginRoot = fileURLToPath(new URL('../context-engine', import.meta.url));
  const run = (command: 'open' | 'record', stdin?: string) => {
    const [cmd, ...args] = coreArgv(pluginRoot, command, { sessionId: 'S1', projectRoot: f.projectRoot });
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd!, args, {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir },
    });
    return parseCoreReply({ exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  };
  const opened = run('open');
  const wc = opened.workingContext;
  assert.equal(wc, `${f.projectRoot}/.context-engine/S1/context.md`);

  const turn1: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'FACT A: purple elephant SENTINEL_DELETE_ME\nFACT B: SENTINEL_V1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
  ];
  const r1 = run('record', JSON.stringify(eventsSinceLastFrame(turn1, wc, opened.frameKey!)));
  assert.equal(r1.receipt, undefined);
  const frame1 = compactionText(wc, readFileSync(wc, 'utf8'), [], undefined, opened.frameKey);
  assert.match(frame1, /\[\[CTX_TURN 1 role=user\]\]\nFACT A: purple elephant SENTINEL_DELETE_ME/);
  assert.match(frame1, /\[\[CTX_TURN 2 role=assistant\]\]\nOK\n<\/working_context>$/);

  // The agent edits the file during turn 2; the turn-2 rows follow the frame it was given.
  writeFileSync(wc, readFileSync(wc, 'utf8').replace('FACT A: purple elephant SENTINEL_DELETE_ME\n', '').replace('_V1', '_V2'));
  const turn2: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: frame1 }, { type: 'text', text: 'Edit it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: wc, old_string: 'SENTINEL_DELETE_ME', new_string: '' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const r2 = run('record', JSON.stringify(eventsSinceLastFrame(turn2, wc, opened.frameKey!)));
  assert.equal(r2.receipt?.kind, 'committed');
  const frame2 = compactionText(wc, readFileSync(wc, 'utf8'), [r2.receipt!.text], undefined, opened.frameKey);
  assert.ok(!frame2.includes('SENTINEL_DELETE_ME'), 'the deleted sentinel is gone');
  assert.ok(!frame2.includes('elephant'));
  assert.match(frame2, /SENTINEL_V2/);
  assert.match(frame2, /Edit it\n\n\[\[CTX_TURN \d+ role=assistant\]\]\n\[tool_use Edit on the Working Context file: input elided\]/);
  assert.match(frame2, /Context Engine: Working Context edit committed as revision \d+/);

  // A missing file is restored from the last Revision, and the receipt says so.
  unlinkSync(wc);
  const r3 = run('record', JSON.stringify([]));
  assert.equal(r3.receipt?.kind, 'restored');
  assert.match(r3.receipt!.text, /file was missing/);
  assert.match(readFileSync(wc, 'utf8'), /SENTINEL_V2/);
});

test('the system-prompt section names the file, the delivery mode and its authority, and nothing of its contents', () => {
  const text = systemSectionText(WC, { sessionId: 'S1', staleRefs: false });
  assert.ok(text.includes(WC));
  assert.ok(text.includes('Full Replacement per user turn; Injection within a turn'));
  assert.match(text, /data/);
  assert.match(text, /authority of a user message/);
  assert.match(text, /\[\[CTX_TURN <n> role=user\|assistant\]\]/);
});

test('the section carries the core recall guidance for this session, and stale-refs guidance only with the experiment on', () => {
  const off = systemSectionText(WC, { sessionId: 'S1', staleRefs: false });
  assert.ok(off.includes(core.RECALL_GUIDANCE.replaceAll('<session-id>', 'S1')));
  assert.ok(!off.includes('<session-id>'));
  assert.ok(!off.includes(core.STALE_REFS_GUIDANCE));
  const on = systemSectionText(WC, { sessionId: 'S1', staleRefs: true });
  assert.ok(on.includes(core.STALE_REFS_GUIDANCE));
});

test('the mod\'s copies of the core guidance lines match the core exactly (the hooks module cannot import the core)', () => {
  assert.equal(RECALL_GUIDANCE, core.RECALL_GUIDANCE);
  assert.equal(STALE_REFS_GUIDANCE, core.STALE_REFS_GUIDANCE);
});

test('the mod\'s copy of the Delivery Mode type describes a mode exactly as the core does', () => {
  for (const m of [TURN_MODE, PER_STEP_MODE]) {
    const c = core.deliveryMode(m.label, m.gaps);
    assert.equal(m.describe(), c.describe());
    assert.deepEqual([...m.gaps], [...c.gaps]);
  }
  assert.equal(deliveryMode('X', ['a', 'b']).describe(), 'X (gaps: a, b)');
  assert.equal(core.deliveryMode('X').describe(), 'X');
  assert.equal(TURN_MODE.describe(), 'Full Replacement per user turn; Injection within a turn');
  assert.equal(PER_STEP_MODE.describe(), 'EXPERIMENTAL: Full Replacement per model step (gaps: hand-written tool schemas, reduced system prompt, no streaming, blind cost ledger)');
});

test('an assistant text that quotes a frame does not count as one', () => {
  const events = eventsSinceLastFrame(
    [
      { role: 'user', content: [{ type: 'text', text: 'Q' }] },
      { role: 'assistant', content: [{ type: 'text', text: compactionText(WC, 'quoted', [], TURN_MODE.label, KEY) }] },
    ],
    WC,
    KEY,
  );
  assert.equal(events[0]?.text, 'Q');
  assert.equal(events.length, 2);
});

test('the Working Context budget is the auto-compact threshold minus what Claude Code puts ahead of it (Pinned Prefix) and the turn reserve', () => {
  const breakdown = {
    autoCompactThreshold: 67_000,
    rawMaxTokens: 100_000,
    isAutoCompactEnabled: true,
    categories: [
      { name: 'System prompt', tokens: 3_000, kind: 'used' as const },
      { name: 'System tools', tokens: 12_000, kind: 'used' as const },
      { name: 'Memory files', tokens: 1_000, kind: 'used' as const },
      { name: 'Messages', tokens: 40_000, kind: 'used' as const },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' as const },
      { name: 'Free space', tokens: 30_000, kind: 'free' as const },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' as const },
    ],
  };
  const fresh = { reserveTokens: 8_000, observed: [] };
  assert.deepEqual(workingContextBudget({ breakdown }), { budgetTokens: 43_000, sharedTokens: 67_000, pinnedTokens: 16_000, ...fresh, source: 'auto-compact threshold' });
  // CONTEXT_ENGINE_BUDGET_TOKENS can lower the shared budget, never raise it past Claude Code's own
  // threshold (Claude Code compacts there regardless); the prefix is still subtracted.
  assert.deepEqual(workingContextBudget({ breakdown, envTokens: '50000' }), { budgetTokens: 26_000, sharedTokens: 50_000, pinnedTokens: 16_000, ...fresh, source: 'CONTEXT_ENGINE_BUDGET_TOKENS' });
  assert.deepEqual(workingContextBudget({ breakdown, envTokens: '100000' }), { budgetTokens: 43_000, sharedTokens: 67_000, pinnedTokens: 16_000, ...fresh, source: 'auto-compact threshold' });
  // Auto-compaction off: the compaction window is the limit.
  assert.equal(workingContextBudget({ breakdown: { ...breakdown, autoCompactThreshold: undefined, isAutoCompactEnabled: false } })!.sharedTokens, 100_000);
  // No breakdown: only an explicit budget, less the Pinned Prefix measured in the smoke run.
  assert.deepEqual(workingContextBudget({ breakdown: null, envTokens: '100000' }), { budgetTokens: 100_000 - DEFAULT_PINNED_TOKENS - 8_000, sharedTokens: 100_000, pinnedTokens: DEFAULT_PINNED_TOKENS, ...fresh, source: 'CONTEXT_ENGINE_BUDGET_TOKENS' });
  assert.equal(workingContextBudget({ breakdown: null }), null);
  assert.equal(workingContextBudget({ breakdown: null, envTokens: 'lots' }), null);
  const none = workingContextBudget({ breakdown: null, envTokens: '25000' });
  assert.equal(none?.exhausted, true, 'no room left after the Pinned Prefix and the reserve: exhausted (the fallback), never "no budget"');
  assert.equal(none?.budgetTokens, 25_000 - DEFAULT_PINNED_TOKENS - 8_000);
  assert.equal(workingContextBudget({ breakdown: null, envTokens: '100000' })?.exhausted, undefined);
});

// Issue #23, from the pilot (fact retention, Adapter, run 0): Claude Code's threshold 67,000 at
// `--autocompact 100k` (/context: 100k window, 33k buffer), Pinned Prefix 7,899 (67,000 minus the
// logged budget 59,101). Turn 13 opened on a ~33,765-token Working Context and its last request was
// 51,452 tokens; the thrash turn (15) delivered a ~58,199-token Working Context as 67,371 tokens.
const PILOT_BREAKDOWN = {
  autoCompactThreshold: 67_000,
  rawMaxTokens: 100_000,
  isAutoCompactEnabled: true,
  categories: [
    { name: 'System prompt', tokens: 3_699, kind: 'used' as const },
    { name: 'System tools', tokens: 4_200, kind: 'used' as const },
    { name: 'Messages', tokens: 43_553, kind: 'used' as const },
  ],
};

test('the budget keeps a reserve for the turn: the input observed on top of the delivered Working Context', () => {
  // Turn 13's own input: 51,452 - 7,899 - 33,765 = 9,788 tokens.
  const b = workingContextBudget({ breakdown: PILOT_BREAKDOWN, turn: { contextTokens: 51_452, deliveredTokens: 33_765, observed: [] } })!;
  assert.deepEqual(b.observed, [9_788]);
  assert.equal(b.reserveTokens, 9_788);
  assert.equal(b.budgetTokens, 67_000 - 7_899 - 9_788);
  // The thrash turn's Working Context fits the old budget (threshold minus Pinned Prefix: 59,101)
  // but not with the turn's input on top of it, so it is over the new one: the fallback fires.
  assert.ok(58_199 <= 59_101);
  assert.ok(58_199 > b.budgetTokens);
});

test('the reserve is the largest turn input observed this session, never under the floor', () => {
  const at = (turn: { contextTokens?: number; deliveredTokens?: number; observed: number[] }) => workingContextBudget({ breakdown: PILOT_BREAKDOWN, turn })!;
  // Nothing observed yet (first compaction, or a resumed process): the floor.
  assert.equal(at({ observed: [] }).reserveTokens, TURN_RESERVE_FLOOR_TOKENS);
  assert.equal(at({ observed: [] }).budgetTokens, 67_000 - 7_899 - TURN_RESERVE_FLOOR_TOKENS);
  // Claude Code reports no usage right after a compaction: no new observation.
  assert.deepEqual(at({ deliveredTokens: 58_199, observed: [9_788] }).observed, [9_788]);
  assert.deepEqual(at({ contextTokens: 67_371, observed: [9_788] }).observed, [9_788]);
  // A small remainder (a compaction mid-turn) does not lower the reserve a full turn set.
  const later = at({ contextTokens: 67_371, deliveredTokens: 58_199, observed: [9_788] });
  assert.deepEqual(later.observed, [9_788, 1_273]);
  assert.equal(later.reserveTokens, 9_788);
  // A Working Context smaller than its readout said cannot make a turn negative.
  assert.deepEqual(at({ contextTokens: 40_000, deliveredTokens: 33_000, observed: [] }).observed, [0]);
  assert.equal(at({ contextTokens: 40_000, deliveredTokens: 33_000, observed: [] }).reserveTokens, TURN_RESERVE_FLOOR_TOKENS);
});

test('through the real core: a Working Context that fits the old budget but not with the turn on top is over budget', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  const pluginRoot = fileURLToPath(new URL('../context-engine', import.meta.url));
  const record = (budget: number) => {
    const [cmd, ...args] = coreArgv(pluginRoot, 'record', { sessionId: 'S1', projectRoot: f.projectRoot }, budget);
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd!, args, { input: '[]', encoding: 'utf8', env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir } });
    return parseCoreReply({ exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
  };
  const wc = record(59_101).workingContext;
  writeFileSync(wc, `[[CTX_TURN 1 role=user]]\n${'x'.repeat(58_199 * 4 - 25)}`);
  assert.equal(record(59_101).budget!.overBudget, false, 'old budget: delivered, and the turn then crossed the threshold');
  const b = workingContextBudget({ breakdown: PILOT_BREAKDOWN, turn: { contextTokens: 51_452, deliveredTokens: 33_765, observed: [] } })!;
  const reply = record(b.budgetTokens);
  assert.equal(reply.budget!.overBudget, true);
  assert.equal(reply.budget!.approxTokens, 58_199);
});

test('the core is passed the budget when there is one', () => {
  const argv = coreArgv('/x/adapters/claude/context-engine', 'record', { sessionId: 'S1', projectRoot: '/proj' }, 51_000);
  assert.deepEqual(argv.slice(-3), ['--if-enabled', '--budget', '51000']);
  assert.ok(!coreArgv('/x/adapters/claude/context-engine', 'record', { sessionId: 'S1', projectRoot: '/proj' }).includes('--budget'));
});

test('the runner summary becomes runner events: one per message, its text and tool calls as plain text', () => {
  assert.deepEqual(
    nativeEvents([
      { role: 'user', text: 'This session is being continued. Summary: FACT 7 = olive-lynx-6510.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: '/p/a.ts' } }] },
      { role: 'user', text: '   ', toolUses: [] },
    ]),
    [
      { role: 'user', text: 'This session is being continued. Summary: FACT 7 = olive-lynx-6510.', source: 'native-compaction' },
      { role: 'assistant', text: '[tool_use Read] {"file_path":"/p/a.ts"}', source: 'native-compaction' },
    ],
  );
});

test('the fallback is labelled Compaction-only, as the core labels it, in a static notice', () => {
  assert.equal(COMPACTION_ONLY_FALLBACK.describe(), core.COMPACTION_ONLY_FALLBACK.describe());
  const n = fallbackNotice({ approxTokensBefore: 61_234, budgetTokens: 51_000, revision: 9 });
  assert.equal(
    n,
    "Context Engine: Compaction-only (fallback: Working Context over budget) for this compaction. Your Working Context was ~61,234 tokens, over its ~51,000-token budget, so Claude Code's own summarizer compacted the conversation instead, and its summary is now your Working Context (revision 9). Everything before it is still in the Event Log (recall).",
  );
  const frame = compactionText(WC, 'SUMMARY', [n], COMPACTION_ONLY_FALLBACK.label);
  assert.match(frame, /delivery="Compaction-only \(fallback: Working Context over budget\)"/);
  assert.doesNotMatch(frame, /Full Replacement/);
});

test('the system section explains the readout and what happens over budget, without numbers or contents', () => {
  const text = systemSectionText(WC, { sessionId: 'S1', staleRefs: false });
  assert.match(text, /readout/);
  assert.ok(text.includes(COMPACTION_ONLY_FALLBACK.label));
  assert.doesNotMatch(text, /\d{2},\d{3}/);
});

test('user text that starts like a frame is not one: a quoted example keeps itself and everything before it', () => {
  const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const quoted = '<working_context file="/elsewhere/context.md" delivery="x">\nexample from the docs\n</working_context>';
  const events = eventsSinceLastFrame(
    [
      { role: 'user', content: [{ type: 'text', text: compactionText(WC, 'old', [], TURN_MODE.label, KEY) }, { type: 'text', text: 'FACT C: SENTINEL_BEFORE' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      { role: 'user', content: [{ type: 'text', text: quoted }] },
      { role: 'assistant', content: [{ type: 'text', text: 'that is a frame example' }] },
    ],
    WC,
    KEY,
  );
  assert.deepEqual(
    events.map((e) => [e.role, e.text]),
    [
      ['user', 'FACT C: SENTINEL_BEFORE'],
      ['assistant', 'noted'],
      ['user', quoted],
      ['assistant', 'that is a frame example'],
    ],
  );
  // A verbatim frame of another session (another key) is not this session's frame either.
  const other = compactionText(WC, 'theirs', [], TURN_MODE.label, 'ffffffffffffffffffffffffffffffff');
  const e2 = eventsSinceLastFrame([{ role: 'user', content: [{ type: 'text', text: 'Q1' }, { type: 'text', text: other }] }], WC, KEY);
  assert.ok(e2[0]?.text.startsWith('Q1\n<working_context'));
});

// ---- review rounds 2 (finding 5) and 3 (finding 1): frames without a frame key ----

/** A real core session in which an older mod (unkeyed frames) delivered revision 1, then the agent deleted a fact. */
function legacySession() {
  const f = fixture();
  setParticipation({ ...f, state: 'on' });
  const pluginRoot = fileURLToPath(new URL('../context-engine', import.meta.url));
  const run = (command: 'open' | 'record' | 'status', stdin?: string) => {
    const [cmd, ...args] = coreArgv(pluginRoot, command, { sessionId: 'S1', projectRoot: f.projectRoot });
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd!, args, { input: stdin, encoding: 'utf8', env: { ...process.env, CONTEXT_ENGINE_STATE_DIR: f.stateDir } });
    return JSON.parse(r.stdout) as { ok: boolean; revision: number; workingContext: string; frameKey?: string; stateDir: string };
  };
  const opened = run('open');
  const wc = opened.workingContext;
  const turn1: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'FACT A: SENTINEL_DELETE_ME\nFACT B: kept' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
  ];
  run('record', JSON.stringify(eventsSinceLastFrame(turn1, wc, opened.frameKey!)));
  // What the older mod delivered: the same frame, without a key.
  const legacyFrame = compactionText(wc, readFileSync(wc, 'utf8'));
  // During the next turn the agent deletes FACT A (committed by a sync as revision 2).
  writeFileSync(wc, readFileSync(wc, 'utf8').replace('FACT A: SENTINEL_DELETE_ME\n', ''));
  run('record', '[]');
  const status = run('status');
  const conversation: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: legacyFrame }, { type: 'text', text: 'Now tidy up.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Tidied.' }] },
  ];
  return { wc, key: opened.frameKey!, run, revision: status.revision, legacyFrame, conversation };
}

const REQUIREMENT = 'NEW REQUIREMENT: SENTINEL_REQUIREMENT';
const stepFor = (messages: ApiMessage[], wc: string, key: string, fileText: string) =>
  JSON.stringify(buildStepRequest({ model: 'm', messages, wcPath: wc, frameKey: key, fileText, sections: [], ownSection: { id: 'own', scope: 'session', text: 'own' }, tools: [] }));

test('unkeyed frames: a real legacy frame, even one holding a committed revision, is refused with a receipt (never taken for the boundary)', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const s = legacySession();
  assert.ok(s.revision >= 2);
  const check = checkLegacyFrame(s.conversation, s.key, s.revision);
  assert.equal(check.kind, 'refused');
  if (check.kind === 'refused') assert.match(check.text, /frame without a frame key[\s\S]*records nothing[\s\S]*stands aside[\s\S]*Claude Code's own compaction/);
});

test('unkeyed frames: a pasted copy of a legacy frame after a new requirement is refused, and is no boundary for recording or the per-step request', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const s = legacySession();
  const pasted: ApiMessage[] = [
    ...s.conversation,
    { role: 'user', content: [{ type: 'text', text: REQUIREMENT }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
    { role: 'user', content: [{ type: 'text', text: s.legacyFrame }, { type: 'text', text: 'Go on.' }] },
  ];
  assert.equal(checkLegacyFrame(pasted, s.key, s.revision).kind, 'refused');
  // Even below the refusal, neither the copy nor the original is a boundary: the requirement stays.
  assert.ok(eventsSinceLastFrame(pasted, s.wc, s.key).some((e) => e.text.includes(REQUIREMENT)));
  assert.ok(stepFor(pasted, s.wc, s.key, readFileSync(s.wc, 'utf8')).includes(REQUIREMENT));
});

test('unkeyed frames: a foreign-session frame holding this session\'s committed text is never a boundary (recording and per-step)', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const s = legacySession();
  const file = readFileSync(s.wc, 'utf8');
  const foreign = compactionText(s.wc, file, [], TURN_MODE.label, 'ffffffffffffffffffffffffffffffff');
  for (const lead of [[], [{ role: 'user', content: [{ type: 'text', text: compactionText(s.wc, file, [], TURN_MODE.label, s.key) }] }]] as ApiMessage[][]) {
    const conversation: ApiMessage[] = [
      ...lead,
      { role: 'user', content: [{ type: 'text', text: REQUIREMENT }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
      { role: 'user', content: [{ type: 'text', text: foreign }, { type: 'text', text: 'Go on.' }] },
    ];
    assert.deepEqual(checkLegacyFrame(conversation, s.key, s.revision), { kind: 'none' });
    const events = eventsSinceLastFrame(conversation, s.wc, s.key);
    assert.equal(events[0]?.text, REQUIREMENT, 'the requirement is new conversation');
    assert.ok(events.at(-1)?.text.endsWith('Go on.'));
    assert.ok(stepFor(conversation, s.wc, s.key, file).includes(REQUIREMENT));
  }
  const r = s.run('record', JSON.stringify(eventsSinceLastFrame([{ role: 'user', content: [{ type: 'text', text: REQUIREMENT }] }, { role: 'user', content: [{ type: 'text', text: foreign }] }], s.wc, s.key)));
  assert.ok(r.ok);
  assert.ok(readFileSync(s.wc, 'utf8').includes(REQUIREMENT), 'the core records it');
});

test('unkeyed frames: no refusal without a committed Working Context, or once a keyed frame exists', { skip: process.platform !== 'linux' && 'requires Linux /proc' }, () => {
  const s = legacySession();
  const quoted: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: compactionText(s.wc, 'quoted') }] }];
  assert.deepEqual(checkLegacyFrame(quoted, s.key, 0), { kind: 'none' });
  const keyedAfter: ApiMessage[] = [...quoted, { role: 'user', content: [{ type: 'text', text: compactionText(s.wc, 'current', [], undefined, s.key) }] }];
  assert.throws(() => checkLegacyFrame(keyedAfter, s.key, s.revision), /ambiguous.*frame/i);
  const plain: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  assert.deepEqual(checkLegacyFrame(plain, s.key, s.revision), { kind: 'none' });
});

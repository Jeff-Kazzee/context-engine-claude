// Hook contracts of the Context Engine mod, run with `claude plugin test adapters/claude/context-engine`.
// The test's own hooks stand for Claude Code beneath the mod: the core CLI ($.process.run), the
// session's id/root/messages, the file system and native compaction are all answered here.
import { type Engine, describe, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

const ROOT = '/proj';
const SID = 'sid-1';
const WC = `${ROOT}/.context-engine/${SID}/context.md`;
const LABEL = 'Full Replacement per user turn; Injection within a turn';
const KEY = '0123456789abcdef0123456789abcdef';
const NATIVE = { messages: [{ role: 'user' as const, text: 'NATIVE SUMMARY', toolUses: [] }] };

const NATIVE_INPUT = [{ role: 'user' as const, text: 'A user turn to compact.', toolUses: [] }];

// The offline bridge forwards internal $.prompt.compose() calls without host inputs.
// Supply synthetic inputs required by the installed API, then run the actual adapter.
// This fixture does not prove what inputs a live host supplies.
const HOST_FIXTURE = {
  plugins: [{
    name: 'fixture-prompt-defaults',
    tier: 'prepend' as const,
    register(on: On) {
      on('prompt.compose', async (_$, e, next) => {
        return next({
          promptModel: 'fixture-model',
          outputStyle: null,
          surfaces: [],
          tools: [],
          traits: [],
          ...e,
        });
      });
    },
  }],
};

type Reply = { exitCode: number; stdout: string };
const ok = (extra: Record<string, unknown> = {}): Reply => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ ok: true, revision: 1, chars: 10, turns: [], workingContext: WC, frameKey: KEY, ...extra })}\n`,
});

/** Claude Code beneath the mod, with a scripted core. */
function world(on: On, script: { core?: (command: string, stdin?: string) => Reply; file?: string | null; files?: Record<string, string>; messages?: unknown[]; nativeResult?: unknown } = {}) {
  const calls: Array<{ argv: readonly string[]; stdin?: string }> = [];
  const logs: string[] = [];
  const native: string[] = [];
  on('process.run', async (_$, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin });
    const r = (script.core ?? (() => ok()))(String(e.argv[2]), e.init?.stdin);
    const parsed = JSON.parse(r.stdout);
    if (parsed.ok && !Object.hasOwn(parsed, 'workingContextText')) parsed.workingContextText = script.file === null ? '' : script.file ?? '[[CTX_TURN 1 role=user]]\nFACT B: SENTINEL_V2';
    return { value: { ...r, stdout: JSON.stringify(parsed), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('session.id', async () => ({ value: SID }));
  on('session.root', async () => ({ value: ROOT }));
  on('fs.read', async (_$, e) => {
    const path = (e as { path?: string }).path ?? '';
    if (script.files && path in script.files) return { value: script.files[path]! };
    if (script.files && path.includes('/revisions/')) throw new Error('ENOENT: no such file');
    if (script.file === null) throw new Error('ENOENT: no such file');
    return { value: script.file ?? '[[CTX_TURN 1 role=user]]\nFACT B: SENTINEL_V2' };
  });
  on('session.messages', async () => ({ value: (script.messages ?? []) as never }));
  const shown: string[] = [];
  on('ui.log', async (_$, e) => {
    logs.push(e.text);
    if (e.to !== 'debug') shown.push(e.text);
    return { value: undefined };
  });
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }));
  const composeInputs: unknown[] = [];
  on('prompt.compose', async (_$, e) => {
    composeInputs.push(e);
    return { sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] };
  });
  on('session.compact', async (_$, e) => {
    native.push(e.trigger);
    return (script.nativeResult ?? NATIVE) as typeof NATIVE;
  });
  return { calls, logs, shown, native, composeInputs, commands: () => calls.map((c) => c.argv[2]) };
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: null, isInteractive: false });

const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: ['Read', 'Edit', 'Write'], outputStyle: null, traits: [] };

async function editedReply(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const delivery = { kind: 'ready', revision: 2, sha256, chars: text.length, bytes: new TextEncoder().encode(text).length,
    text: `Context Engine: additive Working Context data. Earlier native history remains.\n<working_context revision="2" sha256="${sha256}">\n${text}\n</working_context>` };
  return { revision: 2, revisionKind: 'model-edit', chars: text.length, workingContextText: text, delivery,
    receipt: { kind: 'committed', revision: 2, chars: text.length, approxTokens: Math.ceil(text.length / 4), text: 'Edit committed.' } };
}

test('installed coreCli option reaches the retained checkout as one argv value', { ...HOST_FIXTURE, options: { coreCli: '/retained checkout/core/cli.ts' } }, async ($, on) => {
  mock.env(on, {});
  const w = world(on);
  await start($);
  expect(w.calls[0]!.argv[1]).toBe('/retained checkout/core/cli.ts');
});

test('unusable explicit coreCli refuses instead of falling back to the plugin cache', { ...HOST_FIXTURE, options: { coreCli: 'relative/core/cli.ts' } }, async ($, on) => {
  mock.env(on, {});
  const w = world(on);
  await start($);
  expect(w.calls).toEqual([]);
  expect(w.logs.join('\n')).toContain('coreCli must name the canonical absolute');
});

test('accepted tool edit appends only a static read notice while retaining the native result, ref and earlier context', HOST_FIXTURE, async ($, on) => {
  const text = '[[CTX_TURN role=user]]\nWITHIN_TURN_NEW_SENTINEL\n';
  const edited = await editedReply(text);
  mock.env(on, {});
  const w = world(on, { core: command => command === 'sync' ? ok(edited) : ok(), file: text });
  const original = { ref: 42, result: { type: 'update' as const, filePath: WC, content: text,
    structuredPatch: [], originalFile: 'OLD_CONTEXT_SENTINEL' }, text: 'Native write completed.', context: ['Existing tool context.'] };
  on('tool.call', async () => original);
  await start($);
  const output = await $.tool.call({ tool: 'Write', file_path: WC, content: text });
  expect(output.ref).toBe(42);
  expect(output.result).toEqual(original.result);
  expect(output.text).toBe(original.text);
  expect(output.context?.[0]).toBe(original.context[0]);
  expect(output.context?.length).toBe(2);
  expect(output.context?.[1]).toContain(`sha256 ${edited.delivery.sha256}`);
  expect(output.context?.[1]).toContain('This notice does not deliver its content.');
  expect(output.context?.[1]).toContain(`--sha ${edited.delivery.sha256} --framed`);
  expect(output.context?.[1]).not.toContain(text);
  expect(output.context?.[1]).not.toContain('WITHIN_TURN_NEW_SENTINEL');
  expect(output.context?.[1]).not.toContain('<working_context');
  expect(w.calls.find(call => call.argv[2] === 'sync')!.argv).toContain('--delivery-max-bytes');
  const repeated = await $.tool.call({ tool: 'Write', file_path: WC, content: text });
  expect(repeated.context).toEqual(original.context);
});

for (const ending of ['denied', 'thrown', 'successful'] as const) {
  test(`parallel edit survives a last ${ending} sibling without changing its outcome`, HOST_FIXTURE, async ($, on) => {
    mock.env(on, {});
    const text = '[[CTX_TURN role=user]]\nBATCH_EDIT_NEW_SENTINEL\n';
    const edited = await editedReply(text);
    const w = world(on, { core: command => command === 'sync' ? ok(edited) : ok(), file: text });
    let releaseSibling!: () => void;
    const finishSibling = new Promise<void>(resolve => { releaseSibling = resolve; });
    let siblingEntered!: () => void;
    const siblingRunning = new Promise<void>(resolve => { siblingEntered = resolve; });
    let writeExecuted!: () => void;
    const writeNativeDone = new Promise<void>(resolve => { writeExecuted = resolve; });
    const original = { ref: 43, result: { type: 'update' as const, filePath: WC, content: text,
      structuredPatch: [], originalFile: 'BATCH_OLD_SENTINEL' }, text: 'Write done.', context: ['Original context.'] };
    on('tool.call', async (_$, e) => {
      if (e.file_path === WC) { writeExecuted(); return original; }
      siblingEntered();
      await finishSibling;
      if (ending === 'denied') return { deny: 'Fixture denial is unchanged.' };
      if (ending === 'successful') return { ...original, ref: 44, context: ['Sibling context.'] };
      throw new Error('Fixture failure is unchanged.');
    });
    await start($);
    const sibling = $.tool.call({ tool: 'Write', file_path: `${ROOT}/other.txt`, content: 'ordinary' });
    const settledSibling = sibling.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
    await siblingRunning;
    const editedTool = $.tool.call({ tool: 'Write', file_path: WC, content: text });
    let editedReturned = false;
    const completedEdit = editedTool.then(value => { editedReturned = true; return value; });
    await writeNativeDone;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(editedReturned).toBe(false);
    releaseSibling();
    const [output, other] = await Promise.all([completedEdit, settledSibling]);
    expect(output.ref).toBe(original.ref);
    expect(output.result).toEqual(original.result);
    expect(output.text).toBe(original.text);
    const outputs = [output, ...(other.status === 'fulfilled' ? [other.value] : [])];
    const notices = outputs.flatMap(value => value.context ?? []).filter(value => value.includes('This notice does not deliver its content.'));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain(`--sha ${edited.delivery.sha256}`);
    expect(notices[0]).not.toContain('BATCH_EDIT_NEW_SENTINEL');
    expect(output.context?.[0]).toBe(original.context[0]);
    expect(w.commands().filter(command => command === 'sync')).toEqual(['sync']);
    if (ending === 'denied') {
      expect(other.status).toBe('fulfilled');
      if (other.status === 'fulfilled') expect(other.value).toEqual({ deny: 'Fixture denial is unchanged.' });
    } else if (ending === 'thrown') {
      expect(other.status).toBe('rejected');
      // The native test host wraps a throwing fixture hook. Compare its real
      // error with the same call after the pending edit has been delivered.
      const baseline = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/other.txt`, content: 'ordinary' })
        .then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
      expect(baseline.status).toBe('rejected');
      if (other.status === 'rejected' && baseline.status === 'rejected') expect(String(other.reason)).toBe(String(baseline.reason));
      expect(w.commands().filter(command => command === 'sync')).toEqual(['sync']);
    } else {
      expect(other.status).toBe('fulfilled');
      if (other.status === 'fulfilled') {
        expect(other.value.ref).toBe(44);
        expect(other.value.result).toEqual(original.result);
        expect(other.value.context?.[0]).toBe('Sibling context.');
      }
    }
  });
}

test('unchanged revision and unrelated tool results do not add a Working Context copy', HOST_FIXTURE, async ($, on) => {
  mock.env(on, {});
  const text = '[[CTX_TURN role=user]]\nUNCHANGED_CONTEXT\n';
  const unchanged = await editedReply(text);
  const w = world(on, { core: command => command === 'sync' ? ok({ ...unchanged, receipt: undefined }) : ok(), file: text });
  on('tool.call', async (_$, e) => ({ result: { type: 'update' as const, filePath: String(e.file_path), content: text,
    structuredPatch: [], originalFile: text }, context: ['Original result context.'] }));
  await start($);
  const ordinary = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/ordinary.txt`, content: text });
  expect(ordinary.context).toEqual(['Original result context.']);
  expect(w.commands()).toEqual(['open']);
  const same = await $.tool.call({ tool: 'Write', file_path: WC, content: text });
  expect(same.context).toEqual(['Original result context.']);
});

for (const trigger of ['plugin', 'manual', 'auto'] as const) {
  test(`unbudgeted oversized runner append falls back once (${trigger})`, HOST_FIXTURE, async ($, on) => {
    mock.env(on, {});
    const w = world(on, { core: c => c === 'record' ? ok({ chars: 600001 }) : ok() });
    await start($);
    const r = await $.session.compact({ trigger, messages: NATIVE.messages });
    expect(w.native).toEqual([trigger]);
    expect(w.commands()).toEqual(['open', 'record', 'native-compaction']);
    expect(r.messages?.[0]?.text).toContain('Compaction-only');
    expect(r.messages?.[0]?.text).not.toContain('Full Replacement per user turn');
  });
}

test('unbudgeted context at the hard limit is delivered without native compaction', HOST_FIXTURE, async ($, on) => {
  mock.env(on, {});
  const w = world(on, { core: c => c === 'record' ? ok({ chars: 600000 }) : ok() });
  await start($);
  const r = await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT });
  expect(w.native).toEqual([]);
  expect(r.messages?.[0]?.text).toContain('Full Replacement per user turn');
});

test('oversized native summary is returned natively rather than wrapped into an oversized replacement', HOST_FIXTURE, async ($, on) => {
  mock.env(on, {});
  const w = world(on, { core: c => c === 'record' || c === 'native-compaction' ? ok({ chars: 600001 }) : ok() });
  await start($);
  const r = await $.session.compact({ trigger: 'auto', messages: NATIVE.messages });
  expect(w.native).toEqual(['auto']);
  expect(r).toEqual(NATIVE);
});

for (const ending of ['inactive', 'end'] as const) {
  test(`fallback status is cleared on permanent ${ending}`, HOST_FIXTURE, async ($, on) => {
    mock.env(on, {});
    const statuses: Array<string | undefined> = [];
    on('ui.status', async (_$, e) => { statuses.push(e.text); return { value: undefined }; });
    let disabled = false;
    world(on, { core: c => disabled ? { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"disabled"}' } : c === 'record' ? ok({ chars: 600001 }) : ok() });
    await start($);
    await $.session.compact({ trigger: 'plugin', messages: NATIVE.messages });
    expect(statuses[0]).toContain('Compaction-only');
    if (ending === 'inactive') {
      disabled = true;
      await $.session.compact({ trigger: 'plugin', messages: NATIVE.messages });
    } else await $.session.end({ sessionId: SID });
    expect(statuses[statuses.length - 1]).toBeUndefined();
  });
}

describe('session start', () => {
  test('opens the core for this session with node on the checkout core/cli.ts', HOST_FIXTURE, async ($, on) => {
    const w = world(on);
    await start($);
    expect(w.calls.length).toBe(1);
    const [node, cli, ...rest] = w.calls[0]!.argv;
    expect(node).toBe('node');
    expect(cli).toMatch(/^\/.*\/core\/cli\.ts$/);
    expect(cli).not.toMatch(/\/\.\.\//);
    expect(rest).toEqual(['open', '--session', SID, '--project', ROOT, '--runner', 'claude-code', '--hard-limit', '600000', '--if-enabled']);
  });
});

describe('system prompt', () => {
  test('adds one static session-scoped section naming the file, the delivery mode and its authority', HOST_FIXTURE, async ($, on) => {
    const w = world(on);
    mock.env(on, {});
    await start($);
    const { sections } = await $.prompt.compose(compose);
    expect(sections.length).toBe(2);
    expect(w.composeInputs[0]).toEqual(compose);
    const mine = sections[1]!;
    expect(mine.scope).toBe('session');
    expect(mine.id).toBe('context-engine:working-context');
    expect(mine.text).toContain(WC);
    expect(mine.text).toContain(LABEL);
    expect(mine.text).toContain('authority of a user message');
    expect(mine.text).not.toContain('SENTINEL');
    const again = await $.prompt.compose(compose);
    expect(again.sections[1]!.text).toBe(mine.text);
  });

  test('carries the recall guidance for this session; stale-refs guidance only with that experiment on', HOST_FIXTURE, async ($, on) => {
    world(on);
    mock.env(on, {});
    await start($);
    const off = (await $.prompt.compose(compose)).sections[1]!.text;
    expect(off).toContain(`context-engine recall --session ${SID} <words>`);
    expect(off).not.toContain('context-engine cite');
  });

  test('stale-refs guidance appears when CONTEXT_ENGINE_EXPERIMENTS includes stale-refs', HOST_FIXTURE, async ($, on) => {
    world(on);
    mock.env(on, { CONTEXT_ENGINE_EXPERIMENTS: 'other,stale-refs' });
    await start($);
    expect((await $.prompt.compose(compose)).sections[1]!.text).toContain('context-engine cite');
  });
});

describe('compaction', () => {
  for (const trigger of ['plugin', 'manual', 'auto'] as const) {
    test(`a ${trigger} compaction is answered with the Working Context as one user message, no summarizer`, HOST_FIXTURE, async ($, on) => {
      const w = world(on, {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'FACT B: SENTINEL_V1' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        ],
      });
      await start($);
      const r = await $.session.compact({ trigger, messages: NATIVE_INPUT });
      expect(w.native).toEqual([]);
      expect(w.commands()).toEqual(['open', 'record']);
      expect(JSON.parse(w.calls[1]!.stdin!).map((e: { role: string; text: string }) => [e.role, e.text])).toEqual([
        ['user', 'FACT B: SENTINEL_V1'],
        ['assistant', 'OK'],
      ]);
      expect('messages' in r && r.messages?.length).toBe(1);
      const [m] = 'messages' in r ? r.messages! : [];
      expect(m!.role).toBe('user');
      expect(m!.toolUses).toEqual([]);
      expect(m!.text).toStartWith(`<working_context file="${WC}" delivery="${LABEL}" frame="${KEY}">`);
      expect(m!.text).toContain('[[CTX_TURN 1 role=user]]\nFACT B: SENTINEL_V2');
      expect(m!.text).toEndWith('</working_context>');
    });
  }

  test('a core receipt rides in the frame and is logged', HOST_FIXTURE, async ($, on) => {
    const receipt = { kind: 'restored', revision: 2, reason: 'missing', chars: 40, text: 'Context Engine: your Working Context edit was not applied (the file was missing).' };
    const w = world(on, { core: (c) => (c === 'record' ? ok({ receipt }) : ok()) });
    await start($);
    const r = await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    const text = 'messages' in r ? r.messages![0]!.text : '';
    expect(text).toContain(receipt.text);
    expect(w.logs.join('\n')).toContain(receipt.text);
  });

  test('when the core fails, Claude Code compacts natively and the error is logged', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: (c) => (c === 'record' ? { exitCode: 1, stdout: '{"ok":false,"error":"disk on fire"}\n' } : ok()) });
    await start($);
    const r = await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    expect(r).toEqual(NATIVE);
    expect(w.native).toEqual(['manual']);
    expect(w.logs.join('\n')).toContain('disk on fire');
  });

  test('precompute and subagent compactions are left to Claude Code', HOST_FIXTURE, async ($, on) => {
    const w = world(on);
    await start($);
    await $.session.compact({ trigger: 'precompute', messages: NATIVE_INPUT });
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: NATIVE_INPUT });
    expect(w.native).toEqual(['precompute', 'auto']);
    expect(w.commands()).toEqual(['open']);
  });
});

// ---- budget (issue #22): readout, reminders, and the Compaction-only fallback ----

const FALLBACK = 'Compaction-only (fallback: Working Context over budget)';
const BREAKDOWN = {
  autoCompactThreshold: 67_000,
  rawMaxTokens: 100_000,
  isAutoCompactEnabled: true,
  categories: [
    { name: 'System prompt', tokens: 3_000, kind: 'used' },
    { name: 'System tools', tokens: 14_000, kind: 'used' },
    { name: 'Messages', tokens: 60_000, kind: 'used' },
  ],
};

/**
 * Claude Code's context usage, with the breakdown the budget is read from. `tokens` is the input of
 * the last request, one figure per call (the last repeats); absent right after a compaction.
 */
function usage(on: On, tokens: Array<number | undefined> = [77_000], breakdown: typeof BREAKDOWN = BREAKDOWN) {
  const asked: unknown[] = [];
  on('session.usage', async (_$, e) => {
    const t = tokens[Math.min(asked.length, tokens.length - 1)];
    asked.push(e);
    return { value: { startedAt: 0, rateLimits: [], context: { window: 100_000, ...(t === undefined ? {} : { tokens: t }), breakdown } } as never };
  });
  const statuses: Array<string | undefined> = [];
  on('ui.status', async (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  return { asked, statuses };
}

const report = (over: Record<string, unknown>) => ({ budgetTokens: 50_000, approxTokens: 20_000, percent: 40, overBudget: false, tier: 25, urgent: false, text: 'Context Engine: Working Context ~20,000 tokens of its ~50,000-token budget (40%; approx., chars/4).\nContext Engine: the Working Context has passed 25% of its budget.', ...over });

describe('budget', () => {
  test('the core is given the Working Context budget (auto-compact threshold minus the Pinned Prefix and the turn reserve), and its readout rides in the frame', HOST_FIXTURE, async ($, on) => {
    const u = usage(on);
    const w = world(on, { core: (c) => (c === 'record' ? ok({ budget: report({}) }) : ok()) });
    mock.env(on, {});
    await start($);
    const r = await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    const record = w.calls.find((c) => c.argv[2] === 'record')!;
    // 67,000 - 17,000 - the floor (8,000): no turn has been observed yet.
    expect(record.argv.slice(-2)).toEqual(['--budget', '42000']);
    expect(u.asked).toEqual([{ breakdown: 'summary' }]);
    const text = 'messages' in r ? r.messages![0]!.text : '';
    expect(text).toStartWith(`<working_context file="${WC}" delivery="${LABEL}" frame="${KEY}">`);
    expect(text).toContain('~20,000 tokens of its ~50,000-token budget');
    expect(text).toContain('passed 25% of its budget');
    expect(w.native).toEqual([]);
  });

  test('without a breakdown or CONTEXT_ENGINE_BUDGET_TOKENS there is no budget: the frame is delivered as before', HOST_FIXTURE, async ($, on) => {
    on('session.usage', async () => {
      throw new Error('no usage here');
    });
    const w = world(on);
    mock.env(on, {});
    await start($);
    const r = await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    expect(w.calls.find((c) => c.argv[2] === 'record')!.argv).not.toContain('--budget');
    expect('messages' in r && r.messages![0]!.text.startsWith('<working_context')).toBe(true);
  });

  for (const trigger of ['plugin', 'manual', 'auto'] as const) {
    test(`a ${trigger} compaction whose Working Context alone is over budget falls back to Claude Code's summarizer, labelled Compaction-only`, HOST_FIXTURE, async ($, on) => {
      const u = usage(on);
      const w = world(on, {
        core: (c) =>
          c === 'record'
            ? ok({ revision: 7, chars: 240_000, budget: report({ approxTokens: 60_000, percent: 120, overBudget: true, tier: 0, urgent: true }) })
            : c === 'native-compaction'
              ? ok({ revision: 8, chars: 400, budget: report({ approxTokens: 100, percent: 0, tier: 0, text: 'Context Engine: Working Context ~100 tokens of its ~50,000-token budget (0%; approx., chars/4).' }) })
              : ok(),
        file: '[[CTX_TURN 1 role=user]]\nNATIVE SUMMARY',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'TURN TEXT' }] }],
      });
      mock.env(on, {});
      await start($);
      const r = await $.session.compact({ trigger, messages: [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }] });
      expect(w.native).toEqual([trigger]);
      expect(w.commands()).toEqual(['open', 'record', 'native-compaction']);
      const nc = w.calls.find((c) => c.argv[2] === 'native-compaction')!;
      expect(JSON.parse(nc.stdin!)).toEqual([{ role: 'user', text: 'NATIVE SUMMARY', source: 'native-compaction' }]);
      expect(nc.argv.slice(-2)).toEqual(['--budget', '42000']);
      const text = 'messages' in r ? r.messages![0]!.text : '';
      expect(text).toStartWith(`<working_context file="${WC}" delivery="${FALLBACK}" frame="${KEY}">`);
      expect(text).not.toContain('Full Replacement');
      expect(text).toContain(`Context Engine: ${FALLBACK} for this compaction. Your Working Context was ~60,000 tokens, over its ~50,000-token budget`);
      expect(text).toContain('[[CTX_TURN 1 role=user]]\nNATIVE SUMMARY');
      expect(u.statuses).toEqual([`Context Engine: ${FALLBACK}`]);
      expect(w.shown.join('\n')).toContain(FALLBACK);
    });
  }

  test('no room left at all (threshold minus Pinned Prefix minus turn reserve is not positive) falls back to Claude Code\'s summarizer, labelled Compaction-only', HOST_FIXTURE, async ($, on) => {
    // 20,000 threshold - 15,000 Pinned Prefix - 8,000 reserve floor = -3,000.
    const tight = { ...BREAKDOWN, autoCompactThreshold: 20_000, categories: [{ name: 'System prompt', tokens: 3_000, kind: 'used' }, { name: 'System tools', tokens: 12_000, kind: 'used' }, { name: 'Messages', tokens: 4_000, kind: 'used' }] };
    const u = usage(on, [undefined], tight);
    const w = world(on, {
      core: (c) => (c === 'record' ? ok({ revision: 3, chars: 4_000 }) : c === 'native-compaction' ? ok({ revision: 4, chars: 400 }) : ok()),
      file: '[[CTX_TURN 1 role=user]]\nNATIVE SUMMARY',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'TURN TEXT' }] }],
    });
    mock.env(on, {});
    await start($);
    const r = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }] });
    expect(w.native).toEqual(['manual']);
    expect(w.commands()).toEqual(['open', 'record', 'native-compaction']);
    expect(w.calls.find((c) => c.argv[2] === 'record')!.argv).not.toContain('--budget');
    const text = 'messages' in r ? r.messages![0]!.text : '';
    expect(text).toStartWith(`<working_context file="${WC}" delivery="${FALLBACK}" frame="${KEY}">`);
    expect(text).toContain('no room');
    expect(text).toContain('[[CTX_TURN 1 role=user]]\nNATIVE SUMMARY');
    expect(u.statuses).toEqual([`Context Engine: ${FALLBACK}`]);
  });

  test('each compaction keeps room for the turn: the reserve is the input observed on top of the last delivered Working Context', HOST_FIXTURE, async ($, on) => {
    // Claude Code's last request before each compaction: 30,000 (no Working Context delivered yet),
    // 49,000, 45,000 (a smaller turn), then none reported (nothing answered since the last compaction).
    usage(on, [30_000, 49_000, 45_000, undefined]);
    const delivered = [20_000, 21_000, 22_000, 23_000];
    let n = 0;
    const w = world(on, { core: (c) => (c === 'record' ? ok({ budget: report({ approxTokens: delivered[n++] }) }) : ok()) });
    mock.env(on, {});
    await start($);
    for (let i = 0; i < 4; i++) await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    const budgets = w.calls.filter((c) => c.argv[2] === 'record').map((c) => c.argv.at(-1));
    // 1st: the floor, 67,000 - 17,000 - 8,000. 2nd: turn 49,000 - 17,000 - 20,000 = 12,000 reserved.
    // 3rd: turn 45,000 - 17,000 - 21,000 = 7,000; the largest seen (12,000) still holds. 4th: no new turn.
    expect(budgets).toEqual(['42000', '38000', '38000', '38000']);
  });

  test('the budget debug log reports the largest observed turn input, not a count of turns', HOST_FIXTURE, async ($, on) => {
    usage(on, [30_000, 49_000, 45_000, undefined]);
    const delivered = [20_000, 21_000, 22_000, 23_000];
    let n = 0;
    const w = world(on, { core: (c) => (c === 'record' ? ok({ budget: report({ approxTokens: delivered[n++] }) }) : ok()) });
    mock.env(on, {});
    await start($);
    for (let i = 0; i < 4; i++) await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    const budgetLogs = w.logs.filter((text) => text.includes('Working Context budget'));
    // The adapter keeps only the running maximum: none at first, then 12,000 after the smaller 7,000 turn.
    expect(budgetLogs.map((text) => /largest observed turn input (\w+)/.exec(text)?.[1])).toEqual(['none', '12000', '12000', '12000']);
  });

  test('after a fallback the turn is measured on top of the summary that was delivered', HOST_FIXTURE, async ($, on) => {
    usage(on, [77_000, 40_000]);
    let first = true;
    const w = world(on, {
      core: (c) => {
        if (c === 'native-compaction') return ok({ budget: report({ approxTokens: 1_000 }) });
        if (c !== 'record') return ok();
        const r = ok({ budget: report({ approxTokens: first ? 60_000 : 9_000, overBudget: first }) });
        first = false;
        return r;
      },
    });
    mock.env(on, {});
    await start($);
    const turn = [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }];
    await $.session.compact({ trigger: 'manual', messages: turn });
    await $.session.compact({ trigger: 'manual', messages: turn });
    expect(w.native).toEqual(['manual']);
    const records = w.calls.filter((c) => c.argv[2] === 'record').map((c) => c.argv.at(-1));
    // 2nd: 40,000 - 17,000 - 1,000 (the summary) = 22,000 reserved: 67,000 - 17,000 - 22,000.
    expect(records).toEqual(['42000', '28000']);
  });

  test('the next compaction inside the budget is Full Replacement again, and the status line says so', HOST_FIXTURE, async ($, on) => {
    const u = usage(on);
    let over = true;
    const w = world(on, {
      core: (c) => (c === 'record' ? ok({ budget: report({ overBudget: over, tier: 0 }) }) : c === 'native-compaction' ? ok({ budget: report({ tier: 0 }) }) : ok()),
    });
    mock.env(on, {});
    await start($);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }] });
    over = false;
    const r = await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
    expect(w.native).toEqual(['manual']);
    expect('messages' in r && r.messages![0]!.text).toStartWith(`<working_context file="${WC}" delivery="${LABEL}" frame="${KEY}">`);
    expect(u.statuses).toEqual([`Context Engine: ${FALLBACK}`, undefined]);
  });

  test('when recording the native summary as a Revision fails, the native result is still returned and the receipt says it was not recorded', HOST_FIXTURE, async ($, on) => {
    const u = usage(on);
    const w = world(on, {
      core: (c) =>
        c === 'record'
          ? ok({ budget: report({ approxTokens: 60_000, overBudget: true, tier: 0, urgent: true }) })
          : c === 'native-compaction'
            ? { exitCode: 1, stdout: '{"ok":false,"error":"disk full"}\n' }
            : ok(),
    });
    mock.env(on, {});
    await start($);
    const r = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }] });
    expect(r).toEqual(NATIVE);
    expect(w.native).toEqual(['auto']);
    expect(w.commands()).toEqual(['open', 'record', 'native-compaction', 'close']);
    const shown = w.shown.join('\n');
    expect(shown).toContain(FALLBACK);
    expect(shown).toContain('was NOT recorded as a Revision');
    expect(shown).toContain('disk full');
    expect(u.statuses).toEqual([`Context Engine: ${FALLBACK}`, undefined]);
    const again = await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT });
    expect('skip' in again && again.skip).toContain('inactive');
    expect(w.commands()).toEqual(['open', 'record', 'native-compaction', 'close']);
    expect(w.native).toEqual(['auto']);
  });

  test('a skipped native compaction is passed on and the adapter stands aside to prevent replay', HOST_FIXTURE, async ($, on) => {
    usage(on);
    const w = world(on, { core: (c) => (c === 'record' ? ok({ budget: report({ overBudget: true, tier: 0 }) }) : ok()), nativeResult: { skip: 'blocked by a PreCompact hook' } });
    mock.env(on, {});
    await start($);
    const r = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user' as const, text: 'TURN TEXT', toolUses: [] }] });
    expect(r).toEqual({ skip: 'blocked by a PreCompact hook' });
    expect(w.commands()).toEqual(['open', 'record', 'close']);
    const again = await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT });
    expect('skip' in again && again.skip).toContain('inactive');
    expect(w.commands()).toEqual(['open', 'record', 'close']);
    expect(w.native).toEqual(['auto']);
  });
});

describe('one writer per session', () => {
  test('when another live process holds the session, the mod stands aside and says so', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: (c) => (c === 'open' ? { exitCode: 2, stdout: '{"ok":false,"error":"refused","holder":{"pid":42}}\n' } : ok()) });
    await start($);
    const { sections } = await $.prompt.compose(compose);
    expect(sections.length).toBe(1);
    expect(await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT })).toEqual({ skip: expect.stringContaining('Context Engine') });
    expect(await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT })).toEqual(NATIVE);
    expect(w.logs.join('\n')).toContain('refused');
    expect(w.commands()).toEqual(['open']);
  });

  const refusedAtRecord = (c: string): Reply => (c === 'record' ? { exitCode: 2, stdout: '{"ok":false,"error":"refused","holder":{"pid":42}}\n' } : ok());

  test('when the lock is refused at record time, the per-turn plugin compaction is skipped: no summarizer, no Working Context', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: refusedAtRecord });
    await start($);
    expect(await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT })).toEqual({ skip: expect.stringContaining('held by another process') });
    expect(w.native).toEqual([]);
    expect(w.commands()).toEqual(['open', 'record']);
    expect(w.logs.join('\n')).toContain('refused');
  });

  test('when the lock is refused at record time, an auto compaction still runs natively, so the context cannot overflow', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: refusedAtRecord });
    await start($);
    expect(await $.session.compact({ trigger: 'auto', messages: NATIVE_INPUT })).toEqual(NATIVE);
    expect(w.native).toEqual(['auto']);
    expect(w.commands()).toEqual(['open', 'record', 'close']);
    expect(await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT })).toEqual({ skip: expect.stringContaining('inactive') });
    expect(w.commands()).toEqual(['open', 'record', 'close']);
    expect(w.native).toEqual(['auto']);
  });
});

describe('participation (opt-in pilot, kill switch)', () => {
  test('in a project that is not enabled, or with CONTEXT_ENGINE=off, the mod stands aside without a word on screen', HOST_FIXTURE, async ($, on) => {
    const inactive = { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"not enabled for this project"}\n' };
    const w = world(on, { core: () => inactive });
    await start($);
    const { sections } = await $.prompt.compose(compose);
    expect(sections.map((s) => s.id)).toEqual(['intro']);
    expect(await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT })).toEqual({ skip: expect.stringContaining('inactive') });
    expect(await $.session.compact({ trigger: 'auto', messages: NATIVE_INPUT })).toEqual(NATIVE);
    expect(w.native).toEqual(['auto']);
    expect(w.commands()).toEqual(['open']);
    expect(w.shown).toEqual([]);
    expect(w.logs.join('\n')).toContain('not enabled');
  });
});

describe('participation changes mid-session', () => {
  test('after `context-engine disable` or the kill switch, the next compaction stands aside: the trigger\'s is skipped, others run natively', HOST_FIXTURE, async ($, on) => {
    const inactive = { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"disabled for /proj"}\n' };
    const w = world(on, { core: (c) => (c === 'open' || c === 'close' ? ok() : inactive) });
    await start($);
    expect(await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT })).toEqual({ skip: expect.stringContaining('inactive') });
    expect(await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT })).toEqual(NATIVE);
    expect(w.native).toEqual(['manual']);
    await $.session.end({ reason: 'other', sessionId: SID, resume: undefined as never });
    expect(w.commands()).toEqual(['open', 'record', 'close']);
    expect(w.shown).toEqual([]);
  });
});

describe('session end', () => {
  test('closes the core session', HOST_FIXTURE, async ($, on) => {
    const w = world(on);
    await start($);
    await $.session.end({ reason: 'other', sessionId: SID, resume: undefined as never });
    expect(w.commands()).toEqual(['open', 'close']);
  });
});

// ---- experimental per-step mode (V2) ----

const STATE = '/state/proj-sid';
const PER_STEP = 'EXPERIMENTAL: Full Replacement per model step';
const STATUS = `Context Engine: ${PER_STEP} (gaps: hand-written tool schemas, reduced system prompt, no streaming, blind cost ledger)`;
const API_REPLY = {
  model: 'claude-haiku-4-5-20251001',
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Editing.' },
    { type: 'tool_use', id: 'toolu_9', name: 'Edit', input: { file_path: WC, old_string: 'a', new_string: 'b' } },
  ],
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};
const STEP = { turnId: 'turn-1', index: 1, model: 'claude-haiku-4-5-20251001', messageCount: 3 };

/** Claude Code beneath the mod for a per-step session: the API, the auth handle, tools and files. */
function perStepWorld(on: On, opts: { status?: number; reply?: unknown; auth?: boolean } = {}) {
  const fetches: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; auth?: string } }> = [];
  const writes: Array<{ path: string; text: string }> = [];
  const statuses: Array<string | undefined> = [];
  const engineSteps: number[] = [];
  on('session.authorize', async () => ({ value: opts.auth === false ? null : { handle: 'opaque-handle-1', kind: 'bearer' as const } }));
  on('tool.list', async () => ({ value: [{ name: 'Read', description: 'Reads a file.' }, { name: 'Edit', description: 'Edits a file.' }] as never }));
  on('http.fetch', async (_$, e) => {
    fetches.push({ url: e.url, init: e.init });
    const status = opts.status ?? 200;
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(opts.reply ?? API_REPLY) } };
  });
  on('fs.write', async (_$, e) => {
    writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on('ui.status', async (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on('turn.step', async function* (_$, e) {
    engineSteps.push(e.index);
    yield { kind: 'text', index: 0, text: 'ENGINE' };
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  return { fetches, writes, statuses, engineSteps, body: (i = 0) => JSON.parse(fetches[i]!.init!.body!) };
}

async function step($: Engine, input: Record<string, unknown> = STEP) {
  const stream = $.turn.step(input as never);
  const chunks: unknown[] = [];
  for (let r = await stream.next(); ; r = await stream.next()) {
    if (r.done) return { chunks, result: r.value };
    chunks.push(r.value);
  }
}

const coreWithState = (c: string) => (c === 'status' ? ok({ stateDir: STATE, lock: null }) : ok());
const TURN = [
  { role: 'user', content: [{ type: 'text', text: compactionTextFor('[[CTX_TURN 1 role=user]]\nFACT A: SENTINEL_DELETE_ME') }, { type: 'text', text: 'Edit it' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: WC, old_string: 'FACT A: SENTINEL_DELETE_ME\n', new_string: '' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The file has been updated.' }] },
];

function compactionTextFor(body: string): string {
  return `<working_context file="${WC}" delivery="${LABEL}" frame="${KEY}">\nThis message is your Working Context.\n\n${body}\n</working_context>`;
}

describe('per-step mode (experimental, opt-in)', () => {
  test('off by default: every step is Claude Code\'s own, and no request is built', HOST_FIXTURE, async ($, on) => {
    world(on);
    const p = perStepWorld(on);
    mock.env(on, {});
    await start($);
    const { result } = await step($);
    expect(result.answer).toBe('ENGINE');
    expect(p.engineSteps).toEqual([1]);
    expect(p.fetches).toEqual([]);
  });

  test('on by CONTEXT_ENGINE_CLAUDE_MODE=per-step: the step is built from the synced Working Context and the paired tail, sent with the session auth handle', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    const { chunks, result } = await step($);
    expect(p.engineSteps).toEqual([]);
    expect(w.commands()).toContain('sync');
    expect(p.fetches.length).toBe(1);
    const f = p.fetches[0]!;
    expect(f.url).toBe('https://api.anthropic.com/v1/messages');
    expect(f.init!.method).toBe('POST');
    expect(f.init!.auth).toBe('opaque-handle-1');
    expect(Object.keys(f.init!.headers!).map((k) => k.toLowerCase())).not.toContain('authorization');
    const body = p.body();
    // The real adapter calls $.prompt.compose() without an argument while building this step.
    expect(w.composeInputs).toEqual([{ promptModel: 'fixture-model', outputStyle: null, surfaces: [], tools: [], traits: [] }]);
    expect(JSON.stringify(body.system)).toContain('You are Claude Code.');
    expect(JSON.stringify(body.system)).toContain('# Working Context (Context Engine)');
    expect(JSON.stringify(body.system)).toContain(PER_STEP);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].text).toStartWith(`<working_context file="${WC}" delivery="${PER_STEP}" frame="${KEY}">`);
    expect(body.messages[0].content[0].text).toContain('FACT B: SENTINEL_V2');
    expect(JSON.stringify(body)).not.toContain('SENTINEL_DELETE_ME');
    expect(JSON.stringify(body.system)).not.toContain('<working_context file=');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Edit']);
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'Editing.' },
      { kind: 'tool', index: 1, id: 'toolu_9', name: 'Edit' },
      { kind: 'input', index: 1, json: JSON.stringify(API_REPLY.content[1]!.input) },
      { kind: 'stop', stopReason: 'tool_use', usage: { ...API_REPLY.usage, model: API_REPLY.model } },
    ]);
    expect(result.usage).toEqual({ ...API_REPLY.usage, model: API_REPLY.model });
  });

  test('each mod-built request is logged under the core state directory with its usage, and no headers', HOST_FIXTURE, async ($, on) => {
    world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    await step($);
    expect(p.writes.length).toBe(1);
    const w = p.writes[0]!;
    // The SDK canonicalizes fs.write paths before this mock observes them.
    // Compare the complete logical fixture path after native representation;
    // this does not establish support for a real Windows core/state directory.
    const logicalPath = /^[A-Za-z]:[\\/]/.test(w.path) ? w.path.slice(2).replace(/\\/g, '/') : w.path;
    expect(logicalPath).toMatch(new RegExp(`^${STATE}/claude-per-step/\\d+-turn-1-1\\.json$`));
    const rec = JSON.parse(w.text);
    expect(rec.kind).toBe('claude-per-step-request');
    expect(rec.status).toBe(200);
    expect(rec.usage).toEqual(API_REPLY.usage);
    expect(w.text).not.toContain('opaque-handle-1');
    expect(w.text).not.toContain('anthropic-version');
  });

  test('the status and the system section carry the experimental label and its gaps', HOST_FIXTURE, async ($, on) => {
    world(on, { core: coreWithState });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    const { sections } = await $.prompt.compose(compose);
    expect(sections[1]!.text).toContain(`Delivery mode: ${PER_STEP}`);
    expect(sections[1]!.text).toContain('hand-written tool schemas, reduced system prompt, no streaming, blind cost ledger');
    expect(p.statuses).toContain(STATUS);
  });

  test('the first step of a new session (revision 0, no file yet) is built with an empty Working Context', HOST_FIXTURE, async ($, on) => {
    world(on, { core: (c) => (c === 'status' ? ok({ stateDir: STATE, lock: null }) : ok({ revision: 0 })), file: null, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    await step($, { ...STEP, index: 0 });
    expect(p.engineSteps).toEqual([]);
    expect(p.body().messages[0].content[0].text).toContain('(the Working Context file is empty)');
  });

  test('on by the plugin option mode=per-step', { ...HOST_FIXTURE, options: { mode: 'per-step' } }, async ($, on) => {
    world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on);
    mock.env(on, {});
    await start($);
    await step($);
    expect(p.fetches.length).toBe(1);
  });

  test('a failed request is logged and the step is left to Claude Code', HOST_FIXTURE, async ($, on) => {
    const w = world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on, { status: 529, reply: { type: 'error', error: { type: 'overloaded_error' } } });
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    const { result } = await step($);
    expect(result.answer).toBe('ENGINE');
    expect(p.engineSteps).toEqual([1]);
    expect(w.logs.join('\n')).toContain('HTTP 529');
    expect(p.writes.length).toBe(1);
  });

  test('without an auth handle the step is left to Claude Code', HOST_FIXTURE, async ($, on) => {
    world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on, { auth: false });
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    await step($);
    expect(p.fetches).toEqual([]);
    expect(p.engineSteps).toEqual([1]);
  });

  test('with the kill switch on (or the project not enabled), per-step mode is off too: every step is Claude Code\'s own', HOST_FIXTURE, async ($, on) => {
    const inactive = { exitCode: 0, stdout: '{"ok":true,"active":false,"reason":"turned off by the kill switch CONTEXT_ENGINE=off"}\n' };
    const w = world(on, { core: () => inactive, messages: TURN });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step', CONTEXT_ENGINE: 'off' });
    await start($);
    const { result } = await step($);
    expect(result.answer).toBe('ENGINE');
    expect(p.engineSteps).toEqual([1]);
    expect(p.fetches).toEqual([]);
    expect(p.statuses).toEqual([]);
    expect(w.commands()).toEqual(['open']);
  });

  test('subagent steps are Claude Code\'s own', HOST_FIXTURE, async ($, on) => {
    world(on, { core: coreWithState, messages: TURN });
    const p = perStepWorld(on);
    mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
    await start($);
    await step($, { ...STEP, agentId: 'a1' });
    expect(p.fetches).toEqual([]);
    expect(p.engineSteps).toEqual([1]);
  });
});

// ---- review rounds 2 (finding 5) and 3 (finding 1): frames without a frame key ----
//
// An unkeyed frame is never a boundary: matching a committed revision proves the body's content,
// not that this mod built the message (a pasted copy matches too). When one appears in a session
// with a committed Working Context and no keyed frame, the resume is ambiguous and is refused.

describe('frames without a frame key', () => {
  const REV1 = '[[CTX_TURN 1 role=user]]\nFACT A: SENTINEL_DELETE_ME\nFACT B: kept\n';
  const REV2 = '[[CTX_TURN 1 role=user]]\nFACT B: kept\n';
  /** A frame as mods before the frame key built it: no frame attribute. */
  const unkeyed = (body: string) => `<working_context file="${WC}" delivery="${LABEL}">\nThis message is your Working Context.\n\n${body.replace(/\s+$/, '')}\n</working_context>`;
  /** A frame another session built: its own key, here around this session's committed text. */
  const foreign = (body: string) => `<working_context file="${WC}" delivery="${LABEL}" frame="ffffffffffffffffffffffffffffffff">\nThis message is your Working Context.\n\n${body.replace(/\s+$/, '')}\n</working_context>`;
  const REQUIREMENT = 'NEW REQUIREMENT: SENTINEL_REQUIREMENT';
  const conversation = (frame: string) => [
    { role: 'user', content: [{ type: 'text', text: frame }, { type: 'text', text: 'Now tidy up.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Tidied.' }] },
  ];
  /** A real legacy frame, then a new requirement, then a pasted copy of that frame. */
  const pastedCopy = [
    ...conversation(unkeyed(REV1)),
    { role: 'user', content: [{ type: 'text', text: REQUIREMENT }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
    { role: 'user', content: [{ type: 'text', text: unkeyed(REV1) }, { type: 'text', text: 'Go on.' }] },
  ];
  const coreAt = (revision: number) => (c: string) => (c === 'status' ? ok({ stateDir: STATE, revision, lock: null }) : ok({ revision }));
  const files = { [`${STATE}/revisions/1.md`]: REV1, [`${STATE}/revisions/2.md`]: REV2 };
  const REFUSAL = /frame without a recognized frame key[\s\S]*records nothing[\s\S]*stands aside/;

  for (const [name, messages] of [
    ['a real unkeyed frame holding a committed revision', conversation(unkeyed(REV1))],
    ['an unkeyed frame holding no committed revision', conversation(unkeyed('[[CTX_TURN 1 role=user]]\nFACT B: altered'))],
    ['a pasted copy of a legacy frame after a new requirement', pastedCopy],
  ] as const) {
    for (const trigger of ['plugin', 'auto'] as const) {
      test(`${name}: nothing is recorded, the user is told, Claude Code compacts natively, and the mod stands aside (${trigger})`, HOST_FIXTURE, async ($, on) => {
        const w = world(on, { core: coreAt(2), files, messages: messages as unknown[] });
        await start($);
        const r = await $.session.compact({ trigger, messages: NATIVE_INPUT });
        expect(w.commands()).not.toContain('record');
        expect(w.native).toEqual([trigger]);
        expect(r).toEqual(NATIVE);
        expect(w.shown.join('\n')).toMatch(REFUSAL);
        expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
        await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
        expect(w.commands()).not.toContain('record');
        expect(w.native).toEqual([trigger, 'manual']);
      });
    }

    test(`per-step, ${name}: the step is Claude Code's own (the whole conversation), the user is told, and the mod stands aside`, HOST_FIXTURE, async ($, on) => {
      const w = world(on, { core: coreAt(2), files, messages: messages as unknown[] });
      const p = perStepWorld(on);
      mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
      await start($);
      const { result } = await step($);
      expect(result.answer).toBe('ENGINE');
      expect(p.fetches).toEqual([]);
      expect(w.shown.join('\n')).toMatch(REFUSAL);
      expect(w.commands()).not.toContain('record');
      expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
      await step($, { ...STEP, index: 2 });
      expect(p.engineSteps).toEqual([1, 2]);
      expect(p.fetches).toEqual([]);
    });
  }

  test('with a keyed frame in place, a later pasted unkeyed frame is plain conversation: the requirement before it is recorded', HOST_FIXTURE, async ($, on) => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: compactionTextFor(REV2) }] },
      { role: 'user', content: [{ type: 'text', text: REQUIREMENT }] },
      { role: 'user', content: [{ type: 'text', text: unkeyed(REV2) }, { type: 'text', text: 'Go on.' }] },
    ];
    const w = world(on, { core: coreAt(2), files, messages });
    await start($);
    await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT });
    expect(w.native).toEqual([]);
    const recorded = JSON.parse(w.calls.find((c) => c.argv[2] === 'record')!.stdin!) as Array<{ text: string }>;
    expect(recorded.map((e) => e.text).join('\n')).toContain(REQUIREMENT);
  });

  for (const lead of ['no keyed frame', 'a keyed frame'] as const) {
    const foreignConversation = () => [
      ...(lead === 'a keyed frame' ? [{ role: 'user', content: [{ type: 'text', text: compactionTextFor(REV2) }] }] : []),
      { role: 'user', content: [{ type: 'text', text: REQUIREMENT }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
      { role: 'user', content: [{ type: 'text', text: foreign(REV2) }, { type: 'text', text: 'Go on.' }] },
    ];

    test(`a foreign-session frame ${lead === 'no keyed frame' ? 'without this session key refuses recording' : 'after this session key preserves the requirement'}`, HOST_FIXTURE, async ($, on) => {
      const w = world(on, { core: coreAt(2), files, messages: foreignConversation() });
      await start($);
      const result = await $.session.compact({ trigger: 'plugin', messages: NATIVE_INPUT });
      if (lead === 'no keyed frame') {
        expect(result).toEqual(NATIVE);
        expect(w.native).toEqual(['plugin']);
        expect(w.commands()).not.toContain('record');
        expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
        expect(w.shown.join('\n')).toMatch(REFUSAL);
        await $.session.compact({ trigger: 'manual', messages: NATIVE_INPUT });
        expect(w.native).toEqual(['plugin', 'manual']);
        expect(w.commands()).not.toContain('record');
        expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
        return;
      }
      expect(w.native).toEqual([]);
      expect(w.commands()).not.toContain('close');
      const recorded = JSON.parse(w.calls.find((c) => c.argv[2] === 'record')!.stdin!) as Array<{ text: string }>;
      const text = recorded.map((e) => e.text).join('\n');
      expect(text).toContain(REQUIREMENT);
      expect(text).toContain('Go on.');
    });

    test(`per-step: a foreign-session frame ${lead === 'no keyed frame' ? 'without this session key leaves the step to Claude Code' : 'after this session key preserves the requirement'}`, HOST_FIXTURE, async ($, on) => {
      const w = world(on, { core: coreAt(2), files, messages: foreignConversation() });
      const p = perStepWorld(on);
      mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step' });
      await start($);
      const { result } = await step($);
      if (lead === 'no keyed frame') {
        expect(result.answer).toBe('ENGINE');
        expect(p.fetches).toEqual([]);
        expect(p.engineSteps).toEqual([1]);
        expect(w.commands()).not.toContain('record');
        expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
        expect(w.shown.join('\n')).toMatch(REFUSAL);
        await step($, { ...STEP, index: 2 });
        expect(p.fetches).toEqual([]);
        expect(p.engineSteps).toEqual([1, 2]);
        expect(w.commands().filter((c) => c === 'close')).toEqual(['close']);
        return;
      }
      expect(p.engineSteps).toEqual([]);
      expect(w.commands()).not.toContain('close');
      expect(p.fetches.length).toBe(1);
      expect(p.fetches[0]!.init!.body!).toContain(REQUIREMENT);
      expect(p.fetches[0]!.init!.body!).toContain('Go on.');
    });
  }
});

for (const scenario of [
  { budget: '40000', chars: 80001, expectedBudget: '15000' },
  { budget: '1', chars: 1, expectedBudget: undefined },
  { budget: undefined, chars: 600001, expectedBudget: undefined },
]) test(`per-step file overflow uses the host step without a custom request (${scenario.budget ?? 'hard limit'})`, HOST_FIXTURE, async ($, on) => {
  const w = world(on, { file: 'x'.repeat(scenario.chars) });
  const p = perStepWorld(on);
  mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step', ...(scenario.budget ? { CONTEXT_ENGINE_BUDGET_TOKENS: scenario.budget } : {}) });
  await start($);
  const { result } = await step($);
  expect(result.answer).toBe('ENGINE');
  expect(p.engineSteps).toEqual([1]);
  expect(p.fetches).toEqual([]);
  const sync = w.calls.find(c => c.argv[2] === 'sync')!.argv;
  if (scenario.expectedBudget) expect(sync.slice(-2)).toEqual(['--budget', scenario.expectedBudget]);
  expect(w.logs.join('\n')).toContain('budget or hard limit');
});


for (const fallback of ['no-auth', 'failed-response']) test(`per-step budget does not subtract an unsent Working Context after ${fallback}`, HOST_FIXTURE, async ($, on) => {
  const w = world(on, { file: 'x'.repeat(40000) });
  const p = perStepWorld(on, fallback === 'no-auth' ? { auth: false } : { status: 500 });
  mock.env(on, { CONTEXT_ENGINE_CLAUDE_MODE: 'per-step', CONTEXT_ENGINE_BUDGET_TOKENS: '60000' });
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 100000, tokens: 50000, breakdown: BREAKDOWN } } as never }));
  await start($);
  await step($);
  await step($, { ...STEP, index: 2 });
  expect(p.engineSteps).toEqual([1, 2]);
  expect(w.calls.filter(c => c.argv[2] === 'sync').map(c => c.argv.slice(-2))).toEqual([['--budget', '35000'], ['--budget', '35000']]);
});

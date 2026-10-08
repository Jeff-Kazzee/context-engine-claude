// Hook contracts of the trigger plugin, run with `claude plugin test adapters/claude/context-engine-trigger`.
import { type Engine, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

function world(on: On, active = true, configured = true) {
  const compactions: unknown[] = [];
  const logs: string[] = [];
  const calls: string[][] = [];
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  on('session.compact', async (_$, e) => {
    // The kit forwards action arguments here, without the host's later hook
    // event. Capture them exactly: the action accepts instructions, not trigger.
    // Main-adapter tests separately exercise the host's trigger: 'plugin' event.
    compactions.push(e);
    return { messages: [{ role: 'user' as const, text: 'answered', toolUses: [] }] };
  });
  on('prompt.compose', async () => ({ sections: active ? [{ id: 'context-engine:working-context', text: 'active', scope: 'session' as const }] : [] }));
  on('session.id', async () => ({ value: 'sid' }));
  on('session.root', async () => ({ value: '/proj' }));
  on('process.run', async (_$, e) => { calls.push([...e.argv]); return { value: { exitCode: 0, stdout: JSON.stringify({ claude: { active: configured } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }; });
  on('ui.log', async (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  return { compactions, logs, calls, clock: mock.clock(on) };
}

const turn = (extra: { agentId?: string } = {}) => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra });
const start = async ($: Engine, isInteractive: boolean) => {
  await $.session.start({ cwd: '/proj', surface: isInteractive ? 'terminal' : null, isInteractive });
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] });
};

test('after a main-loop turn in an interactive session, it requests compaction once the turn has settled', async ($, on) => {
  const w = world(on);
  await start($, true);
  const r = await $.turn.complete(turn());
  expect(r.text).toBe('ok');
  expect(w.compactions).toEqual([]);
  await w.clock.settle();
  expect(w.compactions).toEqual([{}]);
  expect(w.logs).toEqual([]);
});

test('trigger alone stays inert when the main adapter does not publish its section', async ($, on) => {
  const w = world(on, false);
  await start($, true);
  await $.turn.complete(turn());
  await w.clock.settle();
  expect(w.compactions).toEqual([]);
});

test('cached main-adapter section does not activate a disabled project or kill-switched runner', async ($, on) => {
  const w = world(on, true, false);
  await start($, true);
  await $.turn.complete(turn());
  await w.clock.settle();
  expect(w.compactions).toEqual([]);
});

test('subagent turns do not compact', async ($, on) => {
  const w = world(on);
  await start($, true);
  await $.turn.complete(turn({ agentId: 'a1' }));
  await w.clock.settle();
  expect(w.compactions).toEqual([]);
});

test('headless sessions do not compact from the trigger (the host sends /compact between turns)', async ($, on) => {
  const w = world(on);
  await start($, false);
  await $.turn.complete(turn());
  await w.clock.settle();
  expect(w.compactions).toEqual([]);
});

test('installed trigger uses the configured core path with spaces', { options: { coreCli: '/retained checkout/core/cli.ts' } }, async ($, on) => {
  const w = world(on);
  await start($, true);
  await $.turn.complete(turn());
  await w.clock.settle();
  expect(w.calls[0]![1]).toBe('/retained checkout/core/cli.ts');
  expect(w.compactions).toEqual([{}]);
});

test('invalid explicit trigger core path is reported and never falls back', { options: { coreCli: '../core/cli.ts' } }, async ($, on) => {
  const w = world(on);
  await start($, true);
  await $.turn.complete(turn());
  await w.clock.settle();
  expect(w.calls).toEqual([]);
  expect(w.compactions).toEqual([]);
  expect(w.logs.join('\n')).toContain('coreCli must name the canonical absolute');
});

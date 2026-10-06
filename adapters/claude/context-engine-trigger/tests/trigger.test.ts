// Hook contracts of the trigger plugin, run with `claude plugin test adapters/claude/context-engine-trigger`.
import { type Engine, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

function world(on: On, active = true, configured = true) {
  const compactions: string[] = [];
  const logs: string[] = [];
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  on('session.compact', async (_$, e) => {
    compactions.push(String(e.trigger));
    return { messages: [{ role: 'user' as const, text: 'answered', toolUses: [] }] };
  });
  on('prompt.compose', async () => ({ sections: active ? [{ id: 'context-engine:working-context', text: 'active', scope: 'session' as const }] : [] }));
  on('session.id', async () => ({ value: 'sid' }));
  on('session.root', async () => ({ value: '/proj' }));
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ claude: { active: configured } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }));
  on('ui.log', async (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  return { compactions, logs, clock: mock.clock(on) };
}

const turn = (extra: { agentId?: string } = {}) => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra });
const start = async ($: Engine, isInteractive: boolean) => {
  await $.session.start({ cwd: '/proj', surface: isInteractive ? 'terminal' : null, isInteractive });
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] });
};

test('after a main-loop turn in an interactive session, it compacts once the turn has settled', async ($, on) => {
  const w = world(on);
  await start($, true);
  const r = await $.turn.complete(turn());
  expect(r.text).toBe('ok');
  await w.clock.settle();
  expect(w.compactions).toEqual(['plugin']);
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

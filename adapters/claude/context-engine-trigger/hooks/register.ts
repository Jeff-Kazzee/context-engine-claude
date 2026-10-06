// Context Engine trigger: compacts at each user-turn boundary of an interactive session, so the
// context-engine mod can answer that compaction with the Working Context (Full Replacement per user
// turn; Injection within a turn).
//
// Why a plugin of its own: a plugin's own `$.session.compact` skips that plugin's `session.compact`
// hook as re-entry, and Claude Code would run its native summarizer instead. Why `turn.complete` +
// `$.clock.after(0)`: Claude Code refuses a compaction from `prompt.submit` (it would compact under
// the turn being held). Headless sessions (-p, SDK) refuse `$.session.compact` altogether; there
// the host sends `/compact` between turns, which the mod answers the same way.
import type { EngineInterface, Register } from 'claude-code';

let interactive = false;
let composeInput: Parameters<EngineInterface['prompt']['compose']>[0] | undefined;
let generation = 0;

async function compactNow($: EngineInterface, scheduled: number, input: NonNullable<typeof composeInput>): Promise<void> {
  const current = () => interactive && scheduled === generation;
  try {
    // Positive handshake with the main adapter; a trigger installed on its own stays inert.
    if (!current()) return;
    const composed = await $.prompt.compose(input);
    if (!current()) return;
    if (!composed.sections.some(s => s.id === 'context-engine:working-context')) return;
    const projectRoot = await $.session.root();
    if (!current()) return;
    // Recheck participation at callback time, even if the main adapter has cached its open state.
    const segments: string[] = [];
    for (const part of `${$.plugin.root}/../../../core/cli.ts`.split('/')) {
      if (part === '..') segments.pop();
      else if (part && part !== '.') segments.push(part);
    }
    const checked = await $.process.run(['node', `/${segments.join('/')}`, 'status', '--project', projectRoot, '--json'], { cwd: projectRoot, timeoutMs: 60000 });
    if (!current() || checked.exitCode !== 0 || JSON.parse(checked.stdout).claude?.active !== true) return;
    await $.session.compact({});
  } catch (err: unknown) {
    $.ui.log(`Context Engine trigger: compaction refused: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' });
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    generation++;
    interactive = e.isInteractive;
    composeInput = undefined;
    return next(e);
  });

  on('session.end', async (_$, e, next) => {
    generation++;
    interactive = false;
    composeInput = undefined;
    return next(e);
  });

  on('prompt.compose', async (_$, e, next) => {
    composeInput = e;
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const scheduled = generation;
    const r = await next(e);
    const input = composeInput;
    if (interactive && scheduled === generation && input && !e.agentId) $.clock.after(0, () => compactNow($, scheduled, input));
    return r;
  });
};

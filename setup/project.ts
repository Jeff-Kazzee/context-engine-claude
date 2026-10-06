// Claude-only project participation: never touches another runner's config or ledger.
import { findRecord, killSwitchOn, participation, setParticipation } from '../core/index.ts';
import { installedLedger } from './install.ts';
import type { SetupContext } from './runners.ts';
export function enableProject(ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, state: 'on' });
  const rec = findRecord({ projectRoot })!;
  const lines = [`Context Engine enabled for ${rec.project} and its subdirectories (new Claude sessions).`, installedLedger(ctx, 'claude') ? 'Claude Code: installed here; verify hook loading in a new session.' : 'Claude Code: adapter not installed.'];
  if (killSwitchOn(ctx.env)) lines.push('CONTEXT_ENGINE=off: adapter remains inactive.');
  return lines;
}
export function disableProject(_ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, state: 'off' });
  const p = participation({ projectRoot, env: {} });
  return [`Context Engine disabled for ${p.project} and its subdirectories (new Claude sessions).`];
}

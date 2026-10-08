import { dirname } from 'node:path';
// Claude-only project participation: never touches another runner's config or ledger.
import { findRecord, killSwitchOn, participation, setParticipation } from '../core/index.ts';
import { installedLedger } from './install.ts';
import type { SetupContext } from './runners.ts';
export function enableProject(ctx: SetupContext, projectRoot: string): string[] {
  let ledger;
  try { ledger = installedLedger(ctx, 'claude'); }
  catch (e) {
    setParticipation({ projectRoot, stateDir: dirname(ctx.setupDir), state: 'off' });
    throw e;
  }
  setParticipation({ projectRoot, stateDir: dirname(ctx.setupDir), state: 'on' });
  const rec = findRecord({ projectRoot, stateDir: dirname(ctx.setupDir) })!;
  const lines = [`Context Engine enabled for ${rec.project} and its subdirectories (new Claude sessions).`, ledger ? 'Claude Code: installed here; verify hook loading in a new session.' : 'Claude Code: adapter not installed.'];
  if (killSwitchOn(ctx.env)) lines.push('CONTEXT_ENGINE=off: adapter remains inactive.');
  return lines;
}
export function disableProject(ctx: SetupContext, projectRoot: string): string[] {
  setParticipation({ projectRoot, stateDir: dirname(ctx.setupDir), state: 'off' });
  const p = participation({ projectRoot, stateDir: dirname(ctx.setupDir), env: {} });
  return [`Context Engine disabled for ${p.project} and its subdirectories (new Claude sessions).`];
}

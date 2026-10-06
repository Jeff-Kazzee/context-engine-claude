import { join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { killSwitchOn, participation } from '../core/index.ts';
import { TURN_MODE, PER_STEP_MODE } from '../adapters/claude/context-engine/hooks/adapter.ts';
import { MODE_ENV, perStepOn } from '../adapters/claude/context-engine/hooks/per-step.ts';
import { installedLedger } from './install.ts';
import type { SetupContext } from './runners.ts';
import { CLAUDE_PLUGIN_IDS } from './runners.ts';
import { safeRead } from './files.ts';
export function claudeModeLabel(env: NodeJS.ProcessEnv, home?: string): string {
  let option: unknown;
  if (home) { try { const s = JSON.parse(safeRead(join(home, 'settings.json'))?.toString('utf8') ?? '{}'); const c=s?.pluginConfigs?.['context-engine@context-engine'] ?? s?.pluginConfigs?.['context-engine']; option = c?.options?.mode ?? c?.mode; } catch {} }
  return (perStepOn(env[MODE_ENV], option) ? PER_STEP_MODE : TURN_MODE).describe();
}
export function statusText(ctx: SetupContext, projectRoot: string) {
  const p = participation({ projectRoot, env: ctx.env });
  const ledger = installedLedger(ctx, 'claude');
  const experiments=(ctx.env.CONTEXT_ENGINE_EXPERIMENTS ?? '').split(',').map(v=>v.trim()).filter(v=>v==='stale-refs');
  const label = claudeModeLabel(ctx.env, ctx.claudeHome);
  let pluginsConfigured = false;
  try {
    const settings = JSON.parse(safeRead(join(ctx.claudeHome, 'settings.json'))?.toString('utf8') ?? '{}');
    const installed = JSON.parse(safeRead(join(ctx.claudeHome, 'plugins', 'installed_plugins.json'))?.toString('utf8') ?? '{}');
    pluginsConfigured = CLAUDE_PLUGIN_IDS.every(id => settings.enabledPlugins?.[id] === true && Array.isArray(installed.plugins?.[id]) && installed.plugins[id].length > 0);
  } catch { /* Unreadable, malformed or linked config cannot establish activation. */ }
  const active = !!ledger && pluginsConfigured && p.active;
  const onPath = (ctx.env.PATH ?? '').split(delimiter).some(d => existsSync(join(d, 'context-engine-claude')));
  return { lines: [`Context Engine Claude (checkout ${ctx.checkout})`, `Project: ${projectRoot}: ${p.state}`, `CLI on PATH: ${onPath}`, `Kill switch: ${killSwitchOn(ctx.env)}`, `Experiments: ${experiments.length ? experiments.join(', ') : 'none'}`, `Claude Code: ${ledger ? 'install record present' : 'not installed'}`, `Delivery Mode: ${label}`, active ? 'Configured active here; interactive hook loading is unverified.' : `inactive here (${!ledger ? 'not installed' : !pluginsConfigured ? 'both plugins must be installed and enabled in current Claude settings' : p.reason})`], json: { project: projectRoot, participation: p, experiments, killSwitch: killSwitchOn(ctx.env), claude: ledger ? { installed: ledger.at, mode: label, active, pluginsConfigured, liveLoadingVerified: false } : null } };
}

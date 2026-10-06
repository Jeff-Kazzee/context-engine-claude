// Where each runner keeps its config, what setup touches there, and the runner's own plugin
// commands. The runner homes honour CLAUDE_CONFIG_DIR and CODEX_HOME, so tests and checks can use
// scratch homes; the runner binaries can be swapped with CONTEXT_ENGINE_CLAUDE_BIN/_CODEX_BIN.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateRoot } from '../core/store.ts';
import type { Rule } from './ledger.ts';
import { jsonRule, tomlTablesRule } from './rules.ts';

export interface SetupContext {
  env: NodeJS.ProcessEnv;
  /** This checkout: the Claude plugins are read from it, and the Codex hooks call its CLI. */
  checkout: string;
  setupDir: string;
  claudeHome: string;
  codexHome: string;
}

export function setupContext(env: NodeJS.ProcessEnv = process.env): SetupContext {
  const home = env.HOME || homedir();
  return {
    env,
    checkout: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
    setupDir: join(resolveStateRoot(undefined, env), 'setup'),
    claudeHome: resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude')),
    codexHome: resolve(env.CODEX_HOME || join(home, '.codex')),
  };
}

export const MARKETPLACE = 'context-engine';
export const CLAUDE_PLUGIN_IDS = [`context-engine@${MARKETPLACE}`, `context-engine-trigger@${MARKETPLACE}`] as const;
export const CODEX_PLUGIN_ID = `context-engine@${MARKETPLACE}`;
/** The five hooks of adapters/codex/plugin/hooks/hooks.json, as Codex keys their trust. */
export const CODEX_HOOK_COUNT = 5;

export interface RunnerSpec {
  id: 'claude' | 'codex';
  title: string;
  home: string;
  bin: string;
  /** Config files the runner's plugin commands change: backed up byte for byte first. */
  files: string[];
  /** Directories where the runner creates files during install. */
  watch: string[];
  /** Directories that are ours by name (plugin caches, staged copies). */
  namespaced: string[];
  rules: Record<string, Rule>;
  install: string[][];
  uninstall: string[][];
  /** Runs after the backup, before the runner's commands. */
  prepare?: () => void;
}

export function claudeSpec(ctx: SetupContext): RunnerSpec {
  const h = ctx.claudeHome;
  const settings = join(h, 'settings.json');
  const installed = join(h, 'plugins', 'installed_plugins.json');
  const known = join(h, 'plugins', 'known_marketplaces.json');
  return {
    id: 'claude',
    title: 'Claude Code',
    home: h,
    bin: ctx.env.CONTEXT_ENGINE_CLAUDE_BIN || 'claude',
    files: [settings, installed, known],
    watch: [join(h, 'plugins'), join(h, 'backups')],
    namespaced: [join(h, 'plugins', 'cache', MARKETPLACE), ...CLAUDE_PLUGIN_IDS.map((id) => join(h, 'plugins', 'data', id.replace('@', '-')))],
    rules: {
      [settings]: jsonRule([...CLAUDE_PLUGIN_IDS.map((id) => ['enabledPlugins', id]), ['extraKnownMarketplaces', MARKETPLACE], ...CLAUDE_PLUGIN_IDS.map((id) => ['pluginConfigs', id])]),
      [installed]: jsonRule(CLAUDE_PLUGIN_IDS.map((id) => ['plugins', id])),
      [known]: jsonRule([[MARKETPLACE]]),
    },
    install: [['plugin', 'marketplace', 'add', join(ctx.checkout, 'adapters', 'claude')], ...CLAUDE_PLUGIN_IDS.map((id) => ['plugin', 'install', id])],
    uninstall: [...[...CLAUDE_PLUGIN_IDS].reverse().map((id) => ['plugin', 'uninstall', id]), ['plugin', 'marketplace', 'remove', MARKETPLACE]],
  };
}

/** Runs a runner binary (a .ts/.js path runs with node, for test doubles). */
export function runBinary(bin: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; timeoutMs?: number } = {}): { ok: boolean; output: string; stdout: string } {
  const [file, argv] = /\.[cm]?[jt]s$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  const r = spawnSync(file, argv, { env, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, maxBuffer: 16 << 20 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) return { ok: false, output: r.error.message, stdout: '' };
  return { ok: r.status === 0, output, stdout: r.stdout ?? '' };
}

import { assertSupportedNode } from './node-runtime.mjs';
// Setup commands for people: install, uninstall, enable, disable, status. Text output.
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireSetupLock } from './files.ts';
import { installedLedger, installLocked as install, interruptedInstallStatus, uninstallLocked as uninstall } from './install.ts';
import { disableProject, enableProject } from './project.ts';
import { claudeSpec, type RunnerSpec, setupContext } from './runners.ts';
import { claudeModeLabel, statusText } from './status.ts';

const HELP = `context-engine-claude
  install [--claude]
  uninstall [--claude]
  enable|disable|status [--project <dir>]
  status [--json]
Installs only claude; projects without shared opt-in stay inactive. Backups precede config changes.
Install or reinstall can activate previously enabled projects, including inherited opt-in.
Uninstall keeps session data and shared participation. Disable revokes that scope for both adapters' hooks. Run context-engine-codex disable too to restore Codex project settings.
Check status before starting a new session. See README.md and adapters/claude/README.md.
`;

export async function runSetup(argv: string[]): Promise<number> {
  assertSupportedNode();
  const [command, ...args] = argv;
  const { values } = parseArgs({
    args,
    options: {
      claude: { type: 'boolean' },
      codex: { type: 'boolean' },
      'trust-hooks': { type: 'boolean' },
      project: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.codex || values['trust-hooks']) {
    process.stderr.write('This distribution supports claude only.\n');
    return 1;
  }
  const ctx = setupContext();
  const projectRoot = realpathSync(resolve(values.project ?? process.cwd()));
  const out = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`);
  let release: (() => void) | undefined;
  try {
    if (['install', 'uninstall', 'enable', 'disable'].includes(command ?? '')) release = acquireSetupLock(join(ctx.setupDir, 'claude.setup.lock'));
    if (command === 'install' || command === 'uninstall') {
      const specs: RunnerSpec[] = [claudeSpec(ctx)];
      let failed = false;
      for (const spec of specs) {
        try {
          if (command === 'install') {
            const lines = install(ctx, spec);
            const label = claudeModeLabel(ctx.env, ctx.claudeHome);

            out([`${spec.title}: installed. Delivery Mode: ${label}.`, ...lines.map((l) => `  ${l}`), '  Projects without shared opt-in stay inactive. Previously enabled projects (including inherited opt-in) can activate on install or reinstall.', '  For a project without opt-in, run `context-engine-claude enable` only after approving that scope.', '  Check `context-engine-claude status` in each intended project before starting a new session.']);
          } else {
            // Without an install record, a successful uninstall only undid an interrupted install.
            const installed = !!installedLedger(ctx, spec.id, spec);
            const lines = uninstall(ctx, spec);
            out([installed ? `${spec.title}: uninstalled.` : `${spec.title}: not installed. The interrupted install was rolled back.`, ...lines.map((l) => `  ${l}`), '  Shared participation is retained; reinstall can reactivate previously enabled projects. Disable revokes the selected scope for both adapters\' hooks. Run context-engine-codex disable too to restore Codex project settings.']);
          }
        } catch (e) {
          process.stderr.write(refusal(e));
          failed = true;
        }
      }
      return failed ? 1 : 0;
    }
    if (command === 'enable') {
      out(enableProject(ctx, projectRoot));
      return 0;
    }
    if (command === 'disable') {
      out(disableProject(ctx, projectRoot));
      return 0;
    }
    if (command === 'status') {
      // "Not installed" would hide a half-applied install. Status refuses it, or reports it while a setup lock exists.
      const s = statusText(ctx, projectRoot, interruptedInstallStatus(ctx, claudeSpec(ctx)));
      process.stdout.write(values.json ? `${JSON.stringify(s.json)}\n` : `${s.lines.join('\n')}\n`);
      return 0;
    }
  } catch (e) {
    process.stderr.write(refusal(e));
    return 1;
  } finally { release?.(); }
  process.stderr.write(HELP);
  return 1;
}

/** People read setup refusals, so print the messages that name the paths, never a stack trace. */
function refusal(e: unknown): string {
  const text = (v: unknown) => (v instanceof Error ? v.message : String(v));
  const lines = [text(e)];
  if (e instanceof AggregateError) lines.push(...e.errors.map((inner) => `  ${text(inner)}`));
  else if (e instanceof Error && e.cause !== undefined && !lines[0]!.includes(text(e.cause))) lines.push(`  ${text(e.cause)}`);
  return `${lines.join('\n')}\n`;
}

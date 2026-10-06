# Context Engine for Claude Code

**Release candidate:** tool-schema prose and fixtures are independently authored here. Publication still requires review of this exact snapshot and its fresh history; see [PROVENANCE.md](PROVENANCE.md).

**Source approval and installation acceptance:** this candidate is in an open PR; main remains bootstrap-only. Source merge requires passing offline checks, independent review and Jeff's approval of the exact head. Real persistent plugin loading, interactive delivery and long-session performance remain unverified; these are installation/release acceptance gaps, not substitutes for source review. Do not recommend installation until a supported-host trial proves next-request delivery. No model evaluations or host configuration changes are part of the offline source checks.

**Shared-core correction:** Working Context writes now use an anchored, verified parent directory. Synthetic Linux parent-swap regressions cover swaps before open, temporary-file creation and rename. Both plugin candidates pin this correction; these checks do not establish real-host installation acceptance.

An experimental, opt-in plugin that lets your agent edit its **Working Context** with ordinary tools. This repository ships only the Claude Code adapter and a pinned shared core. It starts **off in every project**. No default-on recommendation or accuracy gain is claimed.

**Full Replacement per user turn; Injection within a turn.** A default-mode edit takes effect at the next user-turn boundary or compaction, not each model step.

## Give this prompt to your agent to set it up

Copy the following prompt, replacing the project placeholder before sending it:

```text
Set up Context Engine for Claude Code from
https://github.com/Jeff-Kazzee/context-engine-claude
for this project: <absolute project path>.
This is the open PR candidate on release/runtime-plugin-agent-guides; main is
bootstrap-only. Verify the candidate commit and source review/owner approval
before any installation trial. Read the CURRENT README.md, AGENTS.md, PROVENANCE.md, SOURCE.json and
adapters/claude/README.md before executing anything. Verify the actual OS,
Node version, claude version and available plugin/mod commands against those
docs and their CLI help. The inherited compatibility baseline is Claude Code 2.1.289 (mods early access);
do not silently install/downgrade a runner or assume another version works.
If access, licensing or runtime support is blocked, stop and report the reason.
Explain config changes and hook trust, then use normal approval controls.
Never read/copy authentication files, tokens or raw private captures. Use the
runner's existing login without inspecting it; no API-key or proxy fallback.
Use a fresh disposable test project FIRST. Install only this runner's plugin,
leave per-step/stale-refs experiments off, enable only the test project, and
run context-engine-claude status there. An installed plugin or a file write is not proof.
Using non-sensitive sentinels, prove a Working Context edit changes what the
NEXT REQUEST contains at the documented delivery boundary. If request-level
evidence is unavailable, explicitly report that acceptance as unverified;
do not expand logging/permissions or claim success. Do not run costly evals.
After the test passes and I approve the target-project scope, enable only the
named project and report exact mode, versions, commands, config/backups changed,
evidence, gaps and disable/uninstall steps. Preserve unrelated work.
```

## 1. Check compatibility before installing

Shared core 0.1.5 uses the full SHA-256 of the canonical project path for private state and participation keys. Legacy 0.1.0 directories and backups are preserved, but are not automatically migrated or merged. Uninstall an old installation using its original checkout/CLI first; retain its backups and session data. After coordinated runner updates, re-enable a fresh disposable project and start a fresh session. Do not mix 0.1.0 with 0.1.5 under a shared `CONTEXT_ENGINE_STATE_DIR`; use a separate, consistently configured state root for a trial. Existing legacy data remains available through the old checkout with its old state root. Valid full-digest keys from 0.1.1 remain unchanged in 0.1.2, 0.1.3 and 0.1.5.

- Linux with `/proc` mounted, Node **24 or newer**. Project reads are checked using open file descriptors under `/proc/self/fd`; unavailable support refuses the read. Windows, macOS and constrained T3 runtimes are not validated targets. Do not relax those checks or sandbox permissions to make installation work.
- Inherited compatibility baseline: **Claude Code 2.1.289 (mods early access)**. These are observed baseline versions, not a guarantee that every machine or newer version works. Inspect `claude --version`, `claude --help` and its plugin help first.
- A custom `CONTEXT_ENGINE_STATE_DIR` must be an absolute path, identical in the setup shell and runner launch environment. Relative state roots are refused rather than resolved differently for each project or hook cwd.
- Use a dedicated state directory owned by your user with private permissions (`0700`). Existing shared or linked state directories are refused without changing their permissions; never point the override at `/tmp` itself or a shared mount root.
- Existing normal runner login. Context Engine does not read, copy, store or proxy credentials. Never inspect `~/.claude/.credentials.json` or `~/.codex/auth.json`; use normal runner authentication if needed.
- Persistent install changes runner configuration through its own plugin commands. Review changes and backups first; ordinary tool permissions and user approvals remain in control.

```sh
node --version
claude --version
claude plugin --help
```

## 2. Install this adapter and try a disposable project

These commands change configuration. Run them only after the preflight above, in a supported environment where you approve plugin installation. Keep the checkout at its installed path: hook commands refer to it. If the sibling adapter is already installed, first choose shared or isolated participation as described below; do not run `enable` until that scope is approved.

```sh
git clone --branch release/runtime-plugin-agent-guides --single-branch https://github.com/Jeff-Kazzee/context-engine-claude.git
cd context-engine-claude
git rev-parse HEAD
# Verify this candidate head against the reviewed PR before proceeding.
npm ci
npm link
context-engine-claude install
# Replace this path with a NEW disposable project, not the repo checkout.
mkdir -p /tmp/context-engine-claude-trial
cd /tmp/context-engine-claude-trial
context-engine-claude enable
context-engine-claude status
```

No runner binary is installed by these commands. `install` defaults to **Claude Code only** and refuses the other runner flag. `enable` covers the selected directory and its subdirectories. This repository does not install or change Codex configuration. Shared participation can activate an already-installed sibling adapter; check the scope below before enabling.

Both distributions vendor the same core. They retain `context-engine` for compatible session `read`/`recall`/`show` commands. Linking the second checkout replaces that generic PATH alias; **always use `context-engine-claude` for install, enable, status, disable and uninstall**. The runtime aliases remain distinct. Default state/participation storage is shared; if both plugins are installed, enabling a project may activate both. Use a consistent, separate `CONTEXT_ENGINE_STATE_DIR` in each runner's launch environment and matching setup shell when you require separate participation. Never mix core versions under a shared generic alias.

Start a new Claude session after enable/disable. Persistent install registers the main mod and interactive companion trigger. Headless `-p`/SDK hosts must send `/compact` between turns. Leave `CONTEXT_ENGINE_CLAUDE_MODE=per-step` unset for the first trial.

The companion now requires the main adapter's composed section and a fresh read-only setup-status check of scoped participation plus both installed/enabled plugins before requesting compaction. This guard does not establish host action-to-hook integration or real request-level delivery. `status` reports current configuration, and explicitly leaves live hook loading unverified. A pre-existing `.context-engine/.gitignore` must be a regular, unlinked file whose last effective rule is `*`; otherwise startup refuses without changing that file. Review and fix that rule locally before retrying.

The visible session frame key is not authentication. Multiple keyed frames, or a keyed frame later in the conversation, make the adapter record nothing and stand aside; start a fresh session. This conservative rule and persistent host delivery still need runtime acceptance. Text resembling `<system-reminder>` is retained because API text alone cannot prove runner authorship. On a post-open core fault, scheduled plugin compaction is skipped; explicit manual and automatic runner compactions retain native fallback.

## 3. Prove delivery, then enable your intended project

Use harmless, unique strings such as `CE_OLD_TEST` and `CE_NEW_TEST`. Ask the agent to locate its own Working Context, retain the active request and decisions, replace the old sentinel with the new one, and proceed across the documented boundary. For Claude Code, that boundary is the next user turn or compaction in default mode.

Inspect authorized, minimally scoped request-level evidence: old sentinel absent, new sentinel delivered, Working Context at user-message authority, and runner instructions/tools/permissions preserved. Do not capture a real private project or authentication. A changed `context.md`, an active status line, or the agent saying it remembered something is insufficient proof of replacement. If your runtime offers no safe request inspection, report the result as **unverified** and keep the test scope.

After you accept the result, move to the intended project and run `context-engine-claude enable`, then `context-engine-claude status`. Preserve the original task, user control and ordinary approval boundaries. Editable context is user data and can retain prompt injections; it does not gain system/developer authority.

Useful agent instructions in an enabled session:

```text
Keep the current request, verified decisions and next step in your Working
Context. Preserve source pointers when offloading large tool outputs. After a
reset, read the current file completely and continue without repeating done work.
```

From that project, replace placeholders with the actual session and event IDs:

```sh
context-engine read --session <session-id>
context-engine recall --session <session-id> decision
context-engine show --session <session-id> <event-id>
```

`read` names every next part when a file needs paging. It refuses files above 16 MiB before loading their payload; offload large content with source pointers instead of relying on unbounded paging. Invalid UTF-8 is refused by reads and citations. `recall` and `show` are limited to the caller's project, with bounded output. Recall may report `accounting: skipped` if the Event Log cannot be written in a sandbox; that path is unit-tested, not established by a real sandbox session.

## 4. Roll back or uninstall

```sh
# Run in the project enabled above:
context-engine-claude disable
CONTEXT_ENGINE=off claude
# Removes this runner's adapter; retains session data:
context-engine-claude uninstall
# Run in its checkout only when removing its PATH links:
npm unlink --global context-engine-claude
```

Claude enable/disable and kill-switch changes apply to new sessions; Codex checks participation at each hook. Backups precede config writes. Failed installation reverses known Context Engine configuration fields while preserving concurrent unmanaged edits, and removes newly created Context Engine namespaces. Unknown changed files are retained with their before-backups rather than overwritten. New files outside those namespaces may belong to concurrent work, so they are retained and reported on failure and uninstall rather than deleted. Their contents are not copied into the ledger. Unchanged configuration is restored byte for byte; if other tools changed it, uninstall removes only Context Engine entries and reports the backup location. Review partial failures before retrying. Unlinking the CLI alone does not uninstall plugin configuration.

Working Contexts live in `<project>/.context-engine/<session>/`, with managed directories private (`0700`) and the file private (`0600`). Existing user-owned managed directories/files are tightened on open; unsafe links, credentials and shared state roots are refused. Setup also refuses nonprivate state roots before changing runner configuration. If an interrupted runner append committed a revision before writing the file, recovery delivers that revision and preserves an intervening stale-file edit in the Event Log with a restore notice. Revisions, the Event Log, participation and install backups live under `$XDG_STATE_HOME/context-engine` (default `~/.local/state/context-engine`; `CONTEXT_ENGINE_STATE_DIR` overrides). Runner homes honor `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Uninstall retains those session records. Deletion from Working Context only removes future model input; prior text remains in runner transcripts and the Event Log. Delete retained data only with your own exact-path approval.

## Troubleshooting and limits

| Symptom | Action |
|---|---|
| Wrong runtime or missing plugin/mod commands | Stop; compare actual CLI help with the baseline. Do not invent a compatibility flag. |
| `/proc` or a confined file read unavailable | Unsupported environment; use a supported host with ordinary permissions. Fail closed. |
| CLI missing, or setup picks wrong runtime | Inspect PATH, use `context-engine-claude` or `node /absolute/checkout/core/cli.ts`; rerun the matching link only when approved. |
| Installed but inactive | Check project scope, `CONTEXT_ENGINE=off`, state-directory consistency, and status reasons. |
| Missing/empty/invalid Working Context or refused reset | Read the visible restore receipt, then reread the latest file. Never force a reset past the gate. |
| Install/uninstall fails | Preserve the output and byte backups; review runner/plugin help and partial changes. Do not overwrite unrelated config. |

Interactive Claude Code behavior and real interactive hook loading after persistent installation remain **unverified**. The original source had scratch-home install round trips and request-level regressions; a split package does not inherit a new installation success claim. No live model evals are required by normal setup. Tests here use synthetic data and scratch runner homes. Warm, fully applied sessions reuse a validated recovery checkpoint; missing, stale or invalid checkpoints rebuild from the full Event Log. This is not a real long-session timeout or interactive performance acceptance claim.

The opt-in per-step mode is **EXPERIMENTAL: Full Replacement per model step**. It has hand-written tool schemas, a reduced system prompt, no streaming and a blind cost ledger. It is off by default. Its schema descriptions and adapter identity differ from the runner. Real per-step behavior after this wording change is unverified; do not reuse earlier wire-identical schema or request-level acceptance claims. Overflow on the compaction path falls back to native summarization and is labelled Compaction-only. Per-step overflow delegates that step to the host; it does not itself establish a compaction or label. The per-step mode uses Claude Code's opaque `$.session.authorize()` handle; the runner itself attaches credentials.

## Source, maintenance and checks

See [SOURCE.json](SOURCE.json) for the exact source commit and core hashes, [PROVENANCE.md](PROVENANCE.md) for CLM credit and licenses, [GLOSSARY.md](GLOSSARY.md) for terms, and the [adapter guide](adapters/claude/README.md) for the runtime contract. The original monorepo/history and private captures are preserved separately and are not shipped here. Core updates must use the same reviewed version in both repositories.

`npm test` runs offline tests serially; `npm run typecheck` checks shipped modules. Tests use stand-in runners and scratch homes, not your login/config. Offline setup checks execute runtime-specific delivery status, default-off isolation, record/edit/sync/read lifecycle and README contracts. Explicit sibling-runner cases remain skipped. Real plugin loading and request-level acceptance remain separate, explicit checks; do not run costly regression/eval commands as an installation side effect.

Multipart Working Context reads include a content digest in the printed next command. Copy that command exactly, including `--sha`; never construct later-part commands without it. If the file changes between parts, restart at part 1. This prevents combining different file versions. The optional stale-reference `cite` command refuses known credential locations (including project `.env` and `.env.*`, `.npmrc`, `.pypirc`, `.ssh`, `.aws` and `.gnupg`) before reading their bytes. This filename policy cannot identify secrets stored under arbitrary names; do not cite private data.

For Claude Code, use direct Read/Edit/Write tools to curate Working Context. If Bash appears in the current tail and the file revision changed, was restored, or lacks a proven delivery baseline on resume, the adapter records nothing from that tail and stands aside for the remainder of the session. Failed observation after Bash and a tool still running at replacement also stand aside. Scheduled compaction is skipped; explicit manual/automatic compaction retains Claude Code's native behavior. Start a fresh session to retry. This conservative rule also applies to opaque scripts and mixed shell output: it preserves the host conversation rather than guessing which command edited the file. Ordinary Bash output with an unchanged, proven delivery baseline remains eligible for recording. Failed Read results retain their actual error message and error status.

During a replacement transaction, new main-session tool starts wait until delivery completes; existing running tools cause refusal. This guard does not coordinate external editors or subagents.

If a Claude compaction recording attempt has an uncertain outcome or its committed tail cannot be delivered, the adapter stands aside to prevent replay; native fallback results are preserved and never invoked twice. Installation pointers and project config writes refuse linked paths. Rollback retains unowned directories, including empty ones.

Setup operations for this runner are serialized by a private setup lock. If setup is interrupted and reports an existing lock, verify no setup process remains before removing the exact reported lock. Do not run concurrent install or uninstall commands.

See the [release statechart and validation map](docs/context-engine-statechart.md) ([PDF](docs/Context-Engine-Statechart.pdf)) for the published e5da333/644d02b baseline. It does not validate later local fixes.

# Context Engine for Claude Code

**Release candidate:** tool-schema prose and fixtures are independently authored here. Publication still requires review of this exact snapshot and its fresh history; see [PROVENANCE.md](PROVENANCE.md).

**Source approval and installation acceptance:** this candidate is in an open PR targeting `dev`. Changes move from the topic branch to `dev`, then through a separately approved promotion to `main`. Main remains bootstrap-only. Source merge requires passing offline checks, independent review and Jeff's approval of the exact head.

Real persistent plugin loading, interactive delivery and long-session performance remain unverified. These are installation/release acceptance gaps, not substitutes for source review. Do not recommend installation until a supported-host trial proves next-request delivery. No model evaluations or host configuration changes are part of the offline source checks.

**Shared-core correction:** Working Context writes now use an anchored, verified parent directory. Synthetic Linux parent-swap regressions cover swaps before open, temporary-file creation and rename. Both plugin candidates pin this correction; these checks do not establish real-host installation acceptance.

An experimental, opt-in plugin that lets your agent edit its **Working Context** with ordinary tools. This repository ships only the Claude Code adapter and a pinned shared core. It starts **off in every project**. No default-on recommendation or accuracy gain is claimed.

**Full Replacement per user turn. Explicit read-back within a turn.** An accepted Working Context edit produces a static revision and digest notice with a command for the retained core CLI. The notice contains no editable content. Use `--framed` and read every part with the same digest. A later continuation of the same user turn can receive the edit as ordinary tool output. This addition retains earlier history and does not guarantee a smaller request. Full Replacement per user turn remains at the existing user-turn or compaction boundary.

The native host places tool-hook context in a system message. Context Engine therefore uses it only for validated metadata and fixed read instructions, never Working Context bytes. An edit does not automatically load the full file into the immediate next model call. The adapter preserves the original tool result and reference. It waits for the root tool batch to finish, then gives each accepted edit revision one notice. Initialization, ordinary events and unchanged revisions produce no edit notice.

The validated packet must fit 32,000 UTF-8 bytes including its carrier and the Working Context budget. Refused or oversized packets are never truncated. A notice or completed file read is not proof of request delivery.

**Later compaction is a separate boundary.** The existing guard stands aside before recording when the native tail contains Bash and the Working Context revision changed since the previous replacement. The CLI read uses Bash. A successful within-turn read does not count as replacement or clear this guard. Do not infer later automatic replacement from a successful read-back test.

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

The [CI workflow](.github/workflows/ci.yml) checks the exact PR source commit on three hosts with Node 24.21.0. Its platform coverage is:

| Host | Maintained coverage | Stateful support |
| --- | --- | --- |
| Linux | Core, setup and adapter suites | Supported with the documented Linux requirements |
| Windows | Pure operations and refusal before state or setup mutation | Unsupported |
| macOS | Pure operations and refusal before state or setup mutation | Unsupported |

Actual Windows and macOS jobs passed on 2026-10-08 in [the initial CI run](https://github.com/Jeff-Kazzee/context-engine-claude/actions/runs/37730431649) at `af9b638f3c9725b1b0d7246df6f35949d0fcf351`. These baseline results do not validate later commits. Each updated PR head requires its own successful CI. Offline contract checks do not prove provider delivery, model behavior or interactive acceptance.

## 1. Check compatibility before installing

The shared core separates host operations through `core/platform-contract.ts`. Its Linux backend inspects actual handles and targets, reports ownership and private-access facts, and owns private creation and permission changes. Context parsing, rendering and token estimates remain usable without selecting a host backend. A future backend must preserve directory confinement, exclusive lock publication, process identity, private access and durability before stateful use. Extracting this contract does not implement Windows or macOS adapters or establish live delivery acceptance.

Shared core 0.1.5 uses the full SHA-256 of the canonical project path for private state and participation keys. Legacy 0.1.0 directories and backups are preserved, but are not automatically migrated or merged. Uninstall an old installation using its original checkout/CLI first; retain its backups and session data. After coordinated runner updates, re-enable a fresh disposable project and start a fresh session. Do not mix 0.1.0 with 0.1.5 under a shared `CONTEXT_ENGINE_STATE_DIR`; use a separate, consistently configured state root for a trial. Existing legacy data remains available through the old checkout with its old state root. Valid full-digest keys from 0.1.1 remain unchanged in 0.1.2, 0.1.3 and 0.1.5.

- Linux with `/proc` mounted and Node **24 or newer** is the supported stateful target. Native Windows and macOS have no verified host backend. Stateful storage, locking, install and uninstall refuse with `CE_UNSUPPORTED_PLATFORM` before mutation. Use the original supported Linux environment and checkout to remove a prior installation. Do not relax confinement checks or sandbox permissions.
- Inherited compatibility baseline: **Claude Code 2.1.289 (mods early access)**. These are observed baseline versions, not a guarantee that every machine or newer version works. Inspect `claude --version`, `claude --help` and its plugin help first.
- A custom `CONTEXT_ENGINE_STATE_DIR` must be an absolute path, identical in the setup shell and runner launch environment. Relative state roots are refused rather than resolved differently for each project or hook cwd.
- Setup now requires each ledger's backup copies to remain inside that ledger's own snapshot. Older project-repair ledgers that reference sibling snapshots are refused. Before updating an existing installation, uninstall with its original checkout and preserve its backups; do not edit a refused ledger to bypass this check.
- Use a dedicated state directory owned by your user with private permissions (`0700`). Existing shared or linked state directories are refused without changing their permissions; never point the override at `/tmp` itself or a shared mount root.
- Existing normal runner login. Setup never opens runner authentication files or uses their credentials. It reads tracked configuration and refuses recognized credential-bearing keys before making backup copies. This is not a universal secret detector: secrets under innocuous keys or in arbitrary text may escape detection. Never inspect `~/.claude/.credentials.json` or `~/.codex/auth.json`; use normal runner authentication if needed.
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

Use harmless, unique strings such as `CE_OLD_TEST` and `CE_NEW_TEST`. Preserve the current human request and the runner instructions, tools and permissions. Test the intended delivery mode explicitly.

For within-turn read-back, first establish a committed Working Context, then edit it while the same user turn continues. The immediate next native request must contain only the static revision-and-digest notice in hook context. It must not contain editable file bytes in a system or developer message. Run the notice's digest-bound CLI command with `--framed` and read every part with the same digest. Read exactly the payload byte count declared in each versioned frame, then check its fixed footer. Body text that resembles a footer is still payload. Inspect the following native request for the complete edited file in ordinary tool output. Earlier native history remains.

An unchanged write and an ordinary tool call must not add another edit notice.

For Full Replacement per user turn, cross the existing user-turn or compaction boundary. Verify that the replacement frame contains the new Working Context at user-message authority and removed history no longer occupies the rebuilt input. Headless hosts must send `/compact` between turns.

Inspect only authorized, scoped request evidence from a disposable project. A changed file, active status, prepared packet, hook return or model statement does not establish delivery. If safe request inspection is unavailable, report delivery as **unverified** and keep the test scope.

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

Claude enable/disable and kill-switch changes apply to new sessions; Codex checks participation at each hook. Backups precede config writes. Configuration with recognized credential-bearing keys is refused before any before/after backup copies. Conservative TOML inspection also refuses escaped keys, inline tables and multiline nonstring forms; keep secrets in normal runner authentication rather than tracked configuration. Failed installation reverses known Context Engine configuration fields while preserving concurrent unmanaged edits, and removes newly created Context Engine namespaces. Unknown changed files are retained with their before-backups rather than overwritten. New files outside those namespaces may belong to concurrent work, so they are retained and reported on failure and uninstall rather than deleted. Their contents are not copied into the ledger. Unchanged configuration is restored byte for byte; if other tools changed it, uninstall removes only Context Engine entries and reports the backup location. Review partial failures before retrying. Unlinking the CLI alone does not uninstall plugin configuration.

Working Contexts live in `<project>/.context-engine/<session>/`, with managed directories private (`0700`) and the file private (`0600`). Existing user-owned managed directories/files are tightened on open; unsafe links, credentials and shared state roots are refused. Setup also refuses nonprivate state roots before changing runner configuration. If an interrupted runner append committed a revision before writing the file, recovery delivers that revision and preserves an intervening stale-file edit in the Event Log with a restore notice. Revisions, the Event Log, participation and install backups live under `$XDG_STATE_HOME/context-engine` (default `~/.local/state/context-engine`; `CONTEXT_ENGINE_STATE_DIR` overrides). Runner homes honor `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Uninstall retains those session records. Deletion from Working Context only removes future model input; prior text remains in runner transcripts and the Event Log. Delete retained data only with your own exact-path approval.

Runner events are inspected before they are appended, rendered or committed. Recognized credential keys/assignments, authorization and cookie headers, private-key markers and selected token prefixes cause the **whole event** (including raw adapter blocks) to be replaced by a fixed omission notice. Numeric values under recognized credential keys are also omitted; ordinary usage counts are retained. Events exceeding inspection limits (1 Mi UTF-16 units, 10,000 visited nodes or depth 32), or containing unsupported metadata objects/accessors, are omitted too; required role/text fields must be own enumerable string data properties and are refused before inspection otherwise; large legitimate outputs can therefore lose recall evidence. Object-key enumeration is not bounded by the visited-node limit. This is a conservative heuristic, not a universal secret detector: unrecognized formats, escaped labels embedded in text and innocuous key names can escape detection. Keep secrets out of prompts and tool output. The policy does not scrub runner transcripts, model-authored Working Context edits, or existing stored history, and performs no retrospective deletion.

If a new session has no committed revision and its Working Context is linked, invalid UTF-8 or over its edit bound, sync refuses and preserves the entry rather than deleting or clearing it. Repair that exact file, or explicitly approve removing that exact entry, before retrying. Existing-revision restore behavior is unchanged. Setup validates every watched runner root for preexisting links/non-directory entries before invoking runner commands; this preflight does not confine concurrent filesystem changes made by an external runner. A ledger-read failure during enable leaves the requested project explicitly off.

Evidence lookups and cold recovery scan the Event Log incrementally. Recall keeps bounded snippets; recovery retains only uncommitted replay candidates. A single very large JSON entry can still consume memory. Citation source reads refuse files above 16 MiB. Optional stale-reference relocation validates line ranges and limits each check to 4,096 candidate windows and 1 MiB of estimated hashing/line work. When enabled, checks also share limits of 64 marker occurrences, 4 MiB of source bytes, 4 MiB of estimated hashing work, eight Git probes of at most 500 ms each, and a four-second cooperative deadline. Sources are cached within the check. Exhaustion reports incomplete and says remaining references were not checked; it does not claim freshness or a nearest moved span. These limits do not delete stored history.

## Troubleshooting and limits

Revision snapshots are limited to 64 MiB of UTF-8 bytes on publication and before reading; runner appends within that ceiling may exceed the model-edit limit. Corrupt or oversized private state fails closed. Event sequences must increase across the complete log; preserve refused state for repair rather than deleting its history. Recovery restores missing accounting for an already committed revision and reports that committed result.

Setup refuses existing runner homes, watched roots and tracked configuration files owned by another user before backing up configuration or invoking runner install commands. Do not bypass an ownership refusal; use your own runner home. Rollback reassesses the captured current configuration and retains late unmanaged edits. If a deletion target changes, setup refuses the deletion and reports any retained candidate for manual recovery.

Setup inventory streams directory entries and refuses more than 4,096 paths, depth beyond 64, or more than 1 MiB of accumulated path names. It never treats a partial inventory as ownership evidence. Configuration containing recognized credential keys is also refused before Context Engine rollback or reverse-edit rewrites it; remove those settings through the runner’s normal configuration process before retrying. Preserve the reported backups on a partial failure.

The managed ignore file and install-pointer deletion are flushed before success. Synthetic fault tests check flush ordering and refusal; they do not prove behavior under real power loss. A relative fallback `HOME` is refused; an explicit absolute state root or absolute `XDG_STATE_HOME` remains valid.

| Symptom | Action |
|---|---|
| Wrong runtime or missing plugin/mod commands | Stop; compare actual CLI help with the baseline. Do not invent a compatibility flag. |
| `/proc` or a confined file read unavailable | Unsupported environment; use a supported host with ordinary permissions. Fail closed. |
| CLI missing, or setup picks wrong runtime | Inspect PATH, use `context-engine-claude` or `node /absolute/checkout/core/cli.ts`; rerun the matching link only when approved. |
| Installed but inactive | Check project scope, `CONTEXT_ENGINE=off`, state-directory consistency, and status reasons. |
| Missing/empty/invalid Working Context or refused reset | Read the visible restore receipt, then reread the latest file. Never force a reset past the gate. |
| Install/uninstall fails | Preserve the output and byte backups; review runner/plugin help and partial changes. Do not overwrite unrelated config. |

Interactive Claude Code behavior and real interactive hook loading after persistent installation remain **unverified**. The original source had scratch-home install round trips and request-level regressions; a split package does not inherit a new installation success claim. No live model evals are required by normal setup. Tests here use synthetic data and scratch runner homes. Warm, fully applied sessions reuse a validated recovery checkpoint; missing, stale or invalid checkpoints rebuild from the full Event Log. This is not a real long-session timeout or interactive performance acceptance claim.

The opt-in per-step mode is **EXPERIMENTAL: Full Replacement per model step**. It has hand-written tool schemas, a reduced system prompt, no streaming and a blind cost ledger. It is off by default. Its schema descriptions and adapter identity differ from the runner. Real per-step behavior after this wording change is unverified; do not reuse earlier wire-identical schema or request-level acceptance claims. Overflow on the compaction path falls back to native summarization and is labelled Compaction-only. Per-step overflow delegates that step to the host; it does not itself establish a compaction or label. Per-step cost logs retain accounting metadata and omit request/response payloads; they cannot prove next-request contents. The per-step mode uses Claude Code's opaque `$.session.authorize()` handle; the runner itself attaches credentials.

## Source, maintenance and checks

See [SOURCE.json](SOURCE.json) for the exact source commit and core hashes, [PROVENANCE.md](PROVENANCE.md) for CLM credit and licenses, [GLOSSARY.md](GLOSSARY.md) for terms, and the [adapter guide](adapters/claude/README.md) for the runtime contract. The original monorepo/history and private captures are preserved separately and are not shipped here. Core updates must use the same reviewed version in both repositories.

`npm test` runs offline tests serially; `npm run typecheck` checks shipped modules. Tests use stand-in runners and scratch homes, not your login/config. Offline setup checks execute runtime-specific delivery status, default-off isolation, record/edit/sync/read lifecycle and README contracts. Explicit sibling-runner cases remain skipped. Real plugin loading and request-level acceptance remain separate, explicit checks; do not run costly regression/eval commands as an installation side effect.

Multipart Working Context reads include a content digest in the printed next command. Copy that command exactly, including `--sha`; never construct later-part commands without it. If the file changes between parts, restart at part 1. This prevents combining different file versions. The optional stale-reference `cite` command refuses known credential locations (including project `.env` and `.env.*`, `.npmrc`, `.pypirc`, `.ssh`, `.aws` and `.gnupg`) before reading their bytes. This filename policy cannot identify secrets stored under arbitrary names; do not cite private data.

For Claude Code, use direct Read/Edit/Write tools to curate Working Context. If Bash appears in the current tail and the file revision changed, was restored, or lacks a proven delivery baseline on resume, the adapter records nothing from that tail and stands aside for the remainder of the session. Failed observation after Bash and a tool still running at replacement also stand aside. Scheduled compaction is skipped; explicit manual/automatic compaction retains Claude Code's native behavior. Start a fresh session to retry. This conservative rule also applies to opaque scripts and mixed shell output: it preserves the host conversation rather than guessing which command edited the file. Ordinary Bash output with an unchanged, proven delivery baseline remains eligible for recording. Failed Read results retain their actual error message and error status.

During a replacement transaction, new main-session tool starts wait until delivery completes; existing running tools cause refusal. This guard does not coordinate external editors or subagents.

If a Claude compaction recording attempt has an uncertain outcome or its committed tail cannot be delivered, the adapter stands aside to prevent replay; native fallback results are preserved and never invoked twice. Installation pointers and project config writes refuse linked paths. Rollback retains unowned directories, including empty ones.

Setup operations for this runner are serialized by a private setup lock. If setup is interrupted and reports an existing lock, verify no setup process remains before removing the exact reported lock. Do not run concurrent install or uninstall commands.

See the [release statechart and validation map](docs/context-engine-statechart.md) ([PDF](docs/Context-Engine-Statechart.pdf)) for the published e5da333/644d02b baseline. It does not validate later local fixes.

Participation updates flush the new record before atomic publication, then flush its directory and state root before reporting success. A flush failure is reported; a failure after publication can leave the new state visible and does not imply rollback. Event Log append and torn-tail repair retain the verified parent descriptor through lease creation, stale-lease cleanup, payload writes and lease release, including when that parent is renamed. These synthetic checks do not establish durability under every filesystem or power-loss condition.

Setup configuration reads are limited to 16 MiB. Setup writes flush the replacement file before rename and its parent afterward; new parents are created through verified descriptors. Concurrent unmanaged configuration changes made during installation are retained during uninstall. Relative runner-home overrides are resolved when setup starts. These checks cover syscall ordering and synthetic failures, not every filesystem's power-loss behavior.

Runner event batches must be dense arrays of data events. The core checks the rendered next revision against its UTF-8 byte cap before appending the batch. If an Event Log append may have persisted but its flush failed, close and reopen the session before retrying; recovery reconciles the durable log. Setup rollback refuses a configuration replacement if captured bytes change, preserves the concurrent edit and retains recovery files. Namespace cleanup uses verified directory descriptors and refuses redirected or unsafe entries. Preserve reported backups and repair the cause before retrying.

Setup refuses recognized Cookie and Set-Cookie fields before copying configuration into backups. Uninstall verifies runner-home, watched-directory and config-file ownership before runner commands. Rollback uses verified parent descriptors for restore and created-file removal; it preserves redirected paths and concurrent edits. Recall, show and read still return evidence when an accounting flush is ambiguous, with accounting reported as skipped.

Recovery and recall refuse complete Event Log records containing invalid UTF-8, malformed JSON or invalid runner-event structure. Show refuses malformed records encountered before the requested event. Complete malformed records are preserved for diagnosis, and refusal does not advance HEAD or replace the Working Context. An incomplete final record remains the separate torn-tail recovery case.

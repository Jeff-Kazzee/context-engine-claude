# Claude Code adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: Claude Code 2.1.289 mods, Node 24+, Linux `/proc`.

Default delivery is **Full Replacement per user turn; Injection within a turn**. `context-engine` answers `session.compact` with the Working Context as one user-role message; `context-engine-trigger` requests compaction at interactive turn boundaries. Headless hosts send `/compact` between turns. Rows become recallable only at compaction. Resume restores the latest committed Revision; ambiguous old unkeyed frames make the mod stand aside rather than guess.

Installation is on hold; read the blocker in the root README first. After the gates are resolved, persistent setup uses `context-engine-claude install`. A transient `--plugin-dir` load without persistent installation records cannot pass the companion's activation guard and cannot establish automatic per-turn delivery. Such a trial is limited to explicit `/compact` tests of the main mod. Hook loading after a real persistent install and the two-plugin interactive bridge remain unverified.

Missing/invalid context restores the last good Revision with a receipt. Budget overflow invokes native summarization and labels that compaction **Compaction-only (fallback: Working Context over budget)**. Core failures can allow native compaction; no replacement claim applies to that fallback.

Per-step mode (`CONTEXT_ENGINE_CLAUDE_MODE=per-step`) is opt-in and experimental: hand-written schemas, reduced system prompt, no streaming, blind cost ledger. Its request uses `$.session.authorize()` as an opaque auth handle; Claude attaches credentials. Context Engine never copies credentials. Schemas retain compatibility keys/types/constraints but use independently authored descriptions and identity wording. Their real per-step behavior has not been measured after this change; earlier captured-schema equality claims do not apply. See [provenance](../../PROVENANCE.md). Do not enable this experiment during initial setup.

`npm test` uses stand-ins and synthetic data. `claude plugin test adapters/claude/context-engine` and `claude plugin test adapters/claude/context-engine-trigger` run the installed runner's offline hook-contract harness; they are explicit checks, not installer side effects or real model evaluations. No original raw request captures or measured-model evidence files ship in this distribution.

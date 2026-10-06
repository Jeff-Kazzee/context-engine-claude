# Claude Code adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: Claude Code 2.1.289 mods, Node 24+, Linux `/proc`.

Default delivery is **Full Replacement per user turn; Injection within a turn**. `context-engine` answers `session.compact` with the Working Context as one user-role message; `context-engine-trigger` requests compaction at interactive turn boundaries. Headless hosts send `/compact` between turns. Rows become recallable only at compaction. Resume restores the latest committed Revision; ambiguous old unkeyed frames make the mod stand aside rather than guess.

Install with `context-engine-claude install`. For a one-session test, after project enablement, load both absolute plugin paths with `claude --plugin-dir /absolute/checkout/adapters/claude/context-engine --plugin-dir /absolute/checkout/adapters/claude/context-engine-trigger`. This does not edit persistent runner settings. Hook loading after a real persistent install remains unverified.

Missing/invalid context restores the last good Revision with a receipt. Budget overflow invokes native summarization and labels that compaction **Compaction-only (fallback: Working Context over budget)**. Core failures can allow native compaction; no replacement claim applies to that fallback.

Per-step mode (`CONTEXT_ENGINE_CLAUDE_MODE=per-step`) is opt-in and experimental: hand-written schemas, reduced system prompt, no streaming, blind cost ledger. Its request uses `$.session.authorize()` as an opaque auth handle; Claude attaches credentials. Context Engine never copies credentials. Schemas retain compatibility keys/types/constraints but use independently authored descriptions and identity wording. Their real per-step behavior has not been measured after this change; earlier captured-schema equality claims do not apply. See [provenance](../../PROVENANCE.md). Do not enable this experiment during initial setup.

`npm test` uses stand-ins and synthetic data. `npm run test:claude-plugins` invokes real runner plugin tests and is an explicit optional check, not an installer side effect. No original raw request captures or measured-model evidence files ship in this distribution.

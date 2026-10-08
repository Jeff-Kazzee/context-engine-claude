# Claude Code adapter contract

Start with the [agent setup prompt and workflow](../../README.md). Baseline: Claude Code 2.1.289 mods, Node 24+, Linux `/proc`.

Default delivery is **Full Replacement per user turn**, with explicit read-back within a turn. `context-engine` answers `session.compact` with the Working Context as one user-role message. `context-engine-trigger` requests compaction at interactive turn boundaries. Headless hosts send `/compact` between turns. Rows become recallable only at compaction. Resume restores the latest committed Revision. Ambiguous old unkeyed frames make the mod stand aside rather than guess.

Within a turn, the default adapter checks a potential Working Context edit after the root tool batch finishes. A newly committed `model-edit` revision produces a static notice with its revision, SHA-256 digest and a safely quoted command for the retained core CLI. The original result, opaque reference and existing context remain unchanged.

The validated packet must fit 32,000 UTF-8 bytes including its carrier and the current Working Context budget. Initialization, unchanged revisions, runner appends, restored or refused packets, and duplicate edit revisions do not produce an edit notice.

Claude Code 2.1.289 serializes `tool.call` result `context[]` as a system message. Editable Working Context bytes must never go there. The notice contains only validated metadata and fixed read instructions.

Run its ordinary CLI read with `--sha` and `--framed`. Read every part using the same digest and format. The versioned frame declares each payload byte count and total file size. Consume exactly that many UTF-8 bytes before checking the footer, even when the body contains a footer lookalike. Framing preserves trailing file whitespace when the native tool trims its outer output.

A later native continuation can receive the complete file as tool output. A notice alone does not deliver content, and an edit does not automatically replace memory in the immediate next call.

The native runner assembles requests and enforces tool permissions. Read-back is additive and retains older native messages plus the independent current human request. It does not evict context or guarantee a smaller request. A prepared packet, emitted notice or read command is not evidence of complete native-request inclusion. Oversized content can use bounded multipart read-back or the existing compaction boundary, with completeness checked separately.

Persistent installation acceptance is unverified. Read the trial requirements in the root README first. After a supported-host trial, persistent setup uses `context-engine-claude install`. A transient `--plugin-dir` load without persistent installation records cannot pass the companion's activation guard and cannot establish automatic per-turn delivery. Such a trial is limited to explicit `/compact` tests of the main mod. Native fixture profiles verify hook loading after disposable installation. Ordinary-profile installation acceptance and the two-plugin interactive bridge remain unverified.

Missing/invalid context restores the last good Revision with a receipt. Budget overflow invokes native summarization and labels that compaction **Compaction-only (fallback: Working Context over budget)**. Core failures can allow native compaction; no replacement claim applies to that fallback.

Per-step mode (`CONTEXT_ENGINE_CLAUDE_MODE=per-step`) is opt-in and experimental: hand-written schemas, reduced system prompt, no streaming, blind cost ledger. Its request uses `$.session.authorize()` as an opaque auth handle; Claude attaches credentials. Context Engine never copies credentials. Schemas retain compatibility keys/types/constraints but use independently authored descriptions and identity wording. Their real per-step behavior has not been measured after this change; earlier captured-schema equality claims do not apply. See [provenance](../../PROVENANCE.md). Do not enable this experiment during initial setup. Before a custom per-step request, the adapter syncs with the current budget and checks the text read against that budget and the hard limit. If it does not fit, Claude Code handles that step itself; this is not a custom replacement or an immediate native-compaction claim.

`npm test` uses stand-ins and synthetic data. `claude plugin test adapters/claude/context-engine` and `claude plugin test adapters/claude/context-engine-trigger` run the installed runner's offline hook-contract harness; they are explicit checks, not installer side effects or real model evaluations. No original raw request captures or measured-model evidence files ship in this distribution.

Bash with a changed/restored or unobserved Working Context causes conservative stand-aside before recording. Use direct Read/Edit/Write and start a fresh session after refusal. The within-turn CLI read uses Bash. Successful read-back does not count as replacement or clear this guard. Source approval and host installation acceptance are separate, as explained in the root README.

The installer stores the canonical shared-core CLI path in each plugin's supported `coreCli` option. Installed plugins call that retained checkout, including paths with spaces. Keep the checkout in place. If it moves, uninstall and reinstall Context Engine from the new location. An explicit invalid path is refused rather than replaced with a guessed cache path.

For source-layout development, omitting `coreCli` selects its explicit `checkout-relative` default. The installer always replaces that default with the retained checkout's absolute path. Empty or malformed explicit values remain errors.

If a tool result has no room for an accepted edit notice, the adapter retains its static revision metadata for a later carrier. It rechecks the current delivery budget before returning the notice. Mid-turn budget estimates preserve the previous replacement baseline until the turn boundary. Status requires both installed plugins to be enabled and configured with canonical, readable core CLI paths. These configuration checks do not establish interactive loading.

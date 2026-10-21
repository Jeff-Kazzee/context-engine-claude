# Release acceptance checklist

Promotion from `dev` to `main`, installation acceptance, and publication are separate decisions. Record the full source SHA, independent review, three platform CI jobs, artifact SHA-256, and the owner's exact approval before promoting a candidate. A TODO failure must be triaged even if the test process exits successfully.

## Supported installation

Follow the root README from a retained checkout at the approved commit. Linux with `/proc`, stable Node 24.22.1+ in 24.x or 26.12.1+ in 26.x, and the documented Claude Code 2.1.289 compatibility baseline are required for the stateful path. Check actual runner help first. Windows and macOS CI cover pure operations and refusal; they do not establish stateful support.

A source archive must retain `package-lock.json` to reproduce `npm ci`. Extract it outside `node_modules`, keep the directory at its installed path, and use the README's `npm ci`, `npm link`, and runtime-specific setup commands. An npm package tarball is a separate inspection artifact; do not assume it includes the lockfile or provides a supported `npm install <tarball>` path. The CLI runs TypeScript source from its retained checkout.

In a disposable project and isolated state root, exercise install, enable, status, disable and uninstall. Test fresh installation, retained opt-in after reinstall, and disable before reinstall. Uninstall preserves shared participation; it does not revoke the sibling adapter's opt-in. Explicit disable stops both adapters' hooks in that shared scope, and `context-engine-codex disable` also restores Codex project settings. Check status before a new session. Scratch-home tests with stand-in runners establish setup behavior only.

## Owner-present acceptance

1. Record the approved source SHA, the SHA-256 of the exact source archive extracted for installation (label any npm inspection tarball hash separately), host, Node and Claude versions. Keep the checkout in place.
2. Install both plugins in the authorized profile and enable only the disposable project. Record status and start a new session.
3. Use direct Read/Edit/Write and harmless sentinels to verify an in-turn edit, complete digest-bound read-back, the replacement frame, and recall without another tool call. Verify the two-plugin interactive bridge separately from headless explicit compaction.
4. Disable before uninstalling if revoking shared participation; check byte-exact restoration where no unrelated configuration changed. Preserve retained Event Logs and backups.

The owner's handoff, recorded outside this repository, reports a live acceptance run labeled v6 on 2026-10-16, including both plugins, an in-turn Read/Edit, the edited replacement frame, no-tool recall and byte-exact restoration. That result belongs to the source version it tested, not every later artifact. Current-head acceptance and bounded long-session behavior remain separate evidence requirements. Do not perform a live trial while the owner is absent.

## Limitations and open decisions

- Stateful Windows and macOS backends are unsupported.
- Active same-user substitution of core-owned private paths, writes after the final validation sample, end-to-end numeric exhaustion, and real power-loss durability remain outside demonstrated guarantees.
- Bash ambiguity can make the adapter stand aside; preserve the native conversation and start a fresh session as documented. Experimental per-step mode stays off for the first trial.
- Keep existing core hardening follow-ups and their evidence. The owner closes core #26.
- The owner authorized dev-to-main promotion and publication for this release on 2026-10-18, conditional on this checklist's requirements passing. Any later release needs its own approval.

## Security gate for source publication

Before approving a release, require all three CI jobs to pass at the exact candidate SHA, including the actual Node runtime guard and both dependency audit steps. Node must be a supported stable security release. Audits include development tools and the temporary native-test package, fail on every reported advisory severity, and fail when the registry cannot be checked. Preserve independent review, artifact hashes and owner approval. Do not publish a candidate whose required guard or audit failed.

These distributions ship source, not Node, PHP, a container or a served application. The runtime guard covers CI, package commands and setup installation. The pinned core/session and adapter entry points remain unchanged, so operators must select a supported Node executable for them. Registry audits do not establish the vulnerability status of native test binaries or hosted action runtimes.

This repository has no automated publisher. CI failure blocks subsequent steps in the maintained job, but repository files cannot prevent an authorized account from manually creating a GitHub release or bypassing repository rules. Verify required checks and bypass policy separately before source publication. No publication is authorized by a passing check. Verified 2026-10-21.

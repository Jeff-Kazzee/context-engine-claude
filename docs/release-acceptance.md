# Release acceptance checklist

Promotion from `dev` to `main`, installation acceptance, and publication are separate decisions. Record the full source SHA, independent review, three platform CI jobs, artifact SHA-256, and the owner's exact approval before promoting a candidate. A TODO failure must be triaged even if the test process exits successfully.

## Supported installation

Follow the root README from a retained checkout at the approved commit. Linux with `/proc`, stable Node 24.22.1+ in 24.x or 26.12.1+ in 26.x, and the documented Claude Code 2.1.289 compatibility baseline are required for the stateful path. Check actual runner help first. Windows and macOS CI cover pure operations and refusal; they do not establish stateful support.

A source archive must retain `package-lock.json` to reproduce `npm ci`. Extract it outside `node_modules`, keep the directory at its installed path, and use the README's chained `node setup/check-node.mjs && npm ci && npm link` command before runtime-specific setup commands. The explicit runtime guard must pass before either package command starts; a root `preinstall` hook alone does not gate npm's dependency writes. An npm package tarball is a separate inspection artifact; do not assume it includes the lockfile or provides a supported `npm install <tarball>` path. The CLI runs TypeScript source from its retained checkout.

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

Before approving a release, require all three CI jobs to pass at the exact candidate SHA, including the actual Node runtime guard and both dependency audit steps. Node must be a supported stable security release. Audits include development tools and the temporary native-test package, fail on every reported advisory severity, and fail when the registry cannot be checked. The separately installed pnpm tool and its compiled dependencies are outside those project audits. Direct pnpm advisory clearance alone does not clear its bundle. The native Windows/macOS lanes stop after the interpreter probe and before checkout or setup-node pending their verified bootstrap; setup-node can invoke preinstalled clients even with package caching disabled, so the hold precedes it; npm and action-setup are not approved fallbacks. Preserve independent review, artifact hashes and owner approval. Do not publish a candidate whose required guard or audit failed.

These distributions ship source, not Node, PHP, a container or a served application. The runtime guard covers CI, package commands and setup installation. The pinned core/session and adapter entry points remain unchanged, so operators must select a supported Node executable for them. Registry audits do not establish the vulnerability status of native test binaries. In the native Windows/macOS lanes, a first-step PowerShell probe derives the actual bundled action interpreter from the ancestor Runner.Worker path, verifies its executable identity and stable Node 24.22.1+ version, and refuses unverified runtime overrides. It expires at the exclusive 2028-04-30 UTC cutoff. The immutable action inventory uses only Node 24 and has no pre hooks. Any new action, nested action, pre hook, early hashFiles expression or failure/always diagnostic step needs a fresh ordering and runtime review. Ordinary steps cannot protect execution that the provider starts before them. An affected or unverifiable provider action interpreter blocks those native lanes; changing PATH Node does not repair it.

This repository has no automated publisher. CI failure blocks subsequent steps in the maintained job, but repository files cannot prevent an authorized account from manually creating a GitHub release or bypassing repository rules. Verify required checks and bypass policy separately before source publication. No publication is authorized by a passing check. Verified 2026-10-21.

## Fixed-runtime Linux CI candidate

The prepared Linux lane uses native exact-event checkout and explicit Docker build/run, with a pinned Ubuntu image and incident-fixed CA package. Only the authenticated Node 24.22.1 executable is extracted; npm, Yarn and Corepack are omitted. The workload runs as the non-root checkout owner with a private environment, dropped capabilities and a read-only original checkout and a fresh owner-only job-data mount. Tests use a private working copy; trusted launchers and runtime policy are frozen into the read-only image before that copy can change. The full runner temporary directory is not exposed. No Docker socket is passed to it. The existing host network-isolated native CLI contracts remain separate dependent steps using the verified per-job exported runtime and pinned CLI binary. No extra container capabilities are requested.

On 2026-10-21 the owner approved test-only use of the exact Node archive for both CE repositories, despite missing build OIDC provenance. The exception permits Linux x64 CI image build/version checks, the constrained workload and per-job offline native contracts only; it permits no merge or publication. The identified braces advisory is excluded only under the reviewed exact pnpm artifact, frozen CE inputs, private configuration, disabled hooks/scripts and fixed commands; changes to that boundary require renewed review. Direct manager advisory clearance alone is insufficient. Container/native compatibility remains unverified until that approved exact-head CI executes. The PowerShell action-probe fixture is inapplicable in the Linux container, which uses no JavaScript actions; it remains in both native platform checks. Core tests and their serial execution remain in the Linux suite, including Python/ctypes prerequisites.

Windows/macOS are not replaced by Linux. Their existing checks remain blocked by the affected bundled action interpreter. A native bootstrap alternative would need authenticated platform/architecture artifacts and a reviewed CA/provenance contract. macOS also needs evidence that the runner does not select its DYLD_INSERT_LIBRARIES Node shell wrapper before the first native step. No native bootstrap or weaker replacement is activated.

The approved exception is limited to the exact Node artifact in [the CI artifact manifest](../.github/actions/security-ci/artifacts.json), for these Linux CI container and per-job offline-contract uses. Its release signature and clear-signed manifest were verified; build OIDC provenance remains unverified. Approval does not cover ordinary profiles, global installations, other projects, publication, deployment or unrelated artifacts.

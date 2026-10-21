#!/usr/bin/env bash
set -euo pipefail
test "$#" = 0
test "$(id -u)" != 0
test "$(command -v node)" = /opt/node/bin/node
test "$(node --version)" = v24.22.1
test "${GITHUB_REPOSITORY:-}" = Jeff-Kazzee/context-engine-claude
cd -- "$GITHUB_WORKSPACE"
test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"
test -d /proc/self/fd
python3 -I -B -c 'import ctypes; ctypes.CDLL(None)'
git --version
node /opt/ce/check-node.mjs

run_maintained_suite() {
  node /opt/ce/ci/check-inputs.mjs
  container_path=$(mktemp "$RUNNER_TEMP/ce-pnpm-path.XXXXXXXX")
  GITHUB_PATH="$container_path" bash /opt/ce/ci/install-ci-pnpm.sh
  test "$(wc -l < "$container_path")" = 1
  IFS= read -r pnpm_bin < "$container_path"
  export PATH="$pnpm_bin:$PATH"
  rm -- "$container_path"
  node /opt/ce/ci/check-pnpm.mjs
  pnpm import --ignore-workspace
  root_receipt="$HOME/root-lock.sha256"
  node /opt/ce/ci/check-lock.mjs root "$PWD" "$root_receipt"
  pnpm audit --audit-level=low --ignore-workspace --ignore-pnpmfile
  node /opt/ce/ci/check-lock.mjs verify "$PWD" "$root_receipt"
  pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace --ignore-pnpmfile
  node /opt/ce/ci/check-lock.mjs verify "$PWD" "$root_receipt"
  git diff --exit-code -- package.json package-lock.json
  runtime=$(mktemp -d "$RUNNER_TEMP/ce-native-package.XXXXXXXX")
  printf '{"private":true}\n' > "$runtime/package.json"
  pnpm --dir "$runtime" add --ignore-workspace --ignore-pnpmfile --lockfile-only --ignore-scripts --save-exact @anthropic-ai/claude-code-linux-x64@2.1.289
  native_receipt="$HOME/native-lock.sha256"
  node /opt/ce/ci/check-lock.mjs native "$runtime" "$native_receipt"
  pnpm --dir "$runtime" audit --audit-level=low --ignore-workspace --ignore-pnpmfile
  node /opt/ce/ci/check-lock.mjs verify "$runtime" "$native_receipt"
  pnpm --dir "$runtime" install --frozen-lockfile --ignore-scripts --ignore-workspace --ignore-pnpmfile
  node /opt/ce/ci/check-lock.mjs verify "$runtime" "$native_receipt"
  python3 -I -B setup/ci/validate-pnpm-archive.test.py
  node node_modules/typescript/bin/tsc --noEmit -p .
  node --test --test-concurrency=1 "core/**/*.test.ts" "setup/*.test.ts" "adapters/claude/test/*.test.ts" "setup/*.test.mjs" "setup/ci/*.test.mjs"
  binary="$runtime/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
  printf '%s  %s\n' a186b99e4a9c88366cd49df2f7dad56c61fc306ef0140b19ee64b7c42a8d1348 "$binary" | sha256sum --check --status
  # Preserve the existing host unshare/runuser contracts without extra Docker caps.
  export_root="$RUNNER_TEMP/ce-native-claude"
  mkdir --mode=700 -- "$export_root"
  install --mode=755 -- /opt/node/bin/node "$export_root/node"
  install --mode=755 -- "$binary" "$export_root/runner"
}

# The reviewed braces exclusion depends on this fixed flow and its input guards.
run_maintained_suite

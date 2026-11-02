set -euo pipefail
runtime="${CE_CONTAINER_DATA:?}/ce-native-claude"
for file in "$runtime/node" "$runtime/runner"; do
  test -f "$file" && test ! -L "$file"
  test "$(stat -c %u "$file")" = "$(id -u)"
  test "$(stat -c %h "$file")" = 1
done
printf '%s  %s\n' e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb "$runtime/node" | sha256sum --check --status
printf '%s  %s\n' a186b99e4a9c88366cd49df2f7dad56c61fc306ef0140b19ee64b7c42a8d1348 "$runtime/runner" | sha256sum --check --status
test "$("$runtime/node" --version)" = v24.22.1
profile="$RUNNER_TEMP/ce-claude-profile"
mkdir -p "$profile"
for plugin in context-engine context-engine-trigger; do
  sudo -n unshare --net -- runuser --user "$(id -un)" -- env -i \
    PATH="$runtime:$PATH" HOME="$profile" CLAUDE_CONFIG_DIR="$profile" \
    DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1 \
    "$runtime/runner" plugin test "$GITHUB_WORKSPACE/adapters/claude/$plugin"
done

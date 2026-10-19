#!/usr/bin/env bash
# Install the pinned Maestro CLI (MAESTRO_VERSION / MAESTRO_SHA256 from the workflow env) from its
# GitHub release, checksum-verified, onto the PATH.
set -euo pipefail
: "${MAESTRO_VERSION:?}" "${MAESTRO_SHA256:?}"
zip="$RUNNER_TEMP/maestro.zip"
curl -fsSL --retry 3 -o "$zip" "https://github.com/mobile-dev-inc/maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip"
if command -v sha256sum >/dev/null; then
  echo "$MAESTRO_SHA256  $zip" | sha256sum -c -
else
  echo "$MAESTRO_SHA256  $zip" | shasum -a 256 -c -
fi
unzip -q -o "$zip" -d "$HOME/.maestro-cli"
echo "$HOME/.maestro-cli/maestro/bin" >>"$GITHUB_PATH"
"$HOME/.maestro-cli/maestro/bin/maestro" --version

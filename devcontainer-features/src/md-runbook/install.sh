#!/bin/sh
# Installs the md-runbook command line from a GitHub release (md-runbook-cli.tgz, the npm package
# as a file), with npm from the node feature. The VS Code extension comes from
# devcontainer-feature.json (customizations.vscode.extensions).
set -eu

VERSION="${VERSION:-latest}"
CLI="${CLI:-true}"
REPO="smojon/md-runbook"

if [ "$CLI" != "true" ]; then
  echo "md-runbook: the command line is not installed (cli=false)"
  exit 0
fi

# The node feature installs Node.js with nvm; its shell setup isn't loaded here.
for dir in /usr/local/share/nvm/current/bin /usr/local/bin; do
  if [ -x "$dir/node" ]; then PATH="$dir:$PATH"; fi
done
if ! command -v npm >/dev/null 2>&1; then
  echo "md-runbook: Node.js is needed (the node feature, ghcr.io/devcontainers/features/node)" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/md-runbook-cli.tgz" ]; then
  # A package next to this script (the feature's own tests; an offline mirror).
  package="$here/md-runbook-cli.tgz"
elif [ "$VERSION" = "latest" ]; then
  # The newest release that has the package (they are pre-releases, which /releases/latest skips).
  package="$(node -e '
    fetch("https://api.github.com/repos/" + process.argv[1] + "/releases?per_page=20", { headers: { "user-agent": "md-runbook-devcontainer-feature" } })
      .then((r) => { if (!r.ok) throw new Error("GitHub API: HTTP " + r.status); return r.json(); })
      .then((releases) => {
        for (const r of releases) {
          if (r.draft) continue;
          const a = (r.assets || []).find((x) => x.name === "md-runbook-cli.tgz");
          if (a) return console.log(a.browser_download_url);
        }
        throw new Error("no release has md-runbook-cli.tgz yet");
      })
      .catch((e) => { console.error("md-runbook: " + e.message); process.exit(1); });
  ' "$REPO")"
else
  package="https://github.com/$REPO/releases/download/v${VERSION#v}/md-runbook-cli.tgz"
fi

echo "md-runbook: installing the command line from $package"
npm install --global --no-audit --no-fund "$package"
md-runbook --version

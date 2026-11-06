# Dev containers and Codespaces

The md-runbook dev container feature installs the command line and the VS Code extension in a
[dev container](https://containers.dev) or a GitHub Codespace. Add it to your
`.devcontainer/devcontainer.json`:

```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/smojon/md-runbook/md-runbook:1": {}
  }
}
```

Rebuild the container. Then `md-runbook run`, `md-runbook lint` and the rest of the
[command line](cli.md) work in its terminal, and VS Code opens runbooks as runbooks.

| Option | Default | Meaning |
| --- | --- | --- |
| `version` | `latest` | The command line's version: a release such as `0.19.0`, or `latest`, the newest release that has it |
| `cli` | `true` | `false`: only the VS Code extension, no command line |

```json
"features": {
  "ghcr.io/smojon/md-runbook/md-runbook:1": { "version": "0.19.0" }
}
```

**What it installs:**

- **The command line**, from the GitHub release: `md-runbook-cli.tgz` is the same package as on
  npm. It needs Node.js, so the feature brings in the official Node.js feature
  (`ghcr.io/devcontainers/features/node`). Releases have carried the file since 0.19.0.
- **The VS Code extension** (`smojon.md-runbook`), which VS Code installs into the container
  from the Marketplace.

The feature installs software only. It doesn't run a runbook, and it doesn't add secrets: a
runbook's `${secret:NAME}` still comes from the environment or VS Code's secret storage.

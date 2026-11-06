# Publishing

Releases are published by GitHub Actions (`.github/workflows/release.yml`) when a version tag is
pushed. The workflow runs the full test matrix (Windows, macOS, Linux), packages the extension,
publishes it to the **Visual Studio Marketplace** and **Open VSX** (each only if its token secret
is set), and creates a GitHub release with the `.vsix` attached.

## One-time setup

### Visual Studio Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create a
   **publisher** with the ID `smojon` (the `publisher` field in `package.json`; change that field
   if you pick another ID).
2. In Azure DevOps (<https://dev.azure.com>, any organization) open **User settings → Personal
   access tokens → New token**:
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined → Marketplace → Manage**
   - An expiry that suits you (it can be renewed).
3. In the GitHub repository open **Settings → Secrets and variables → Actions → New repository
   secret**, name it `VSCE_PAT` and paste the token.

### Open VSX (VSCodium, Cursor, Gitpod, openvscode-server)

1. Sign in at <https://open-vsx.org> with GitHub, accept the publisher agreement, and create an
   access token under **Settings → Access Tokens**.
2. Create the namespace once (it must match the publisher):
   `npx ovsx create-namespace smojon -p <token>`
3. Add the token as the repository secret `OVSX_PAT`.

### npm (the command-line runner)

The Release workflow also publishes the command line as the npm package
[`md-runbook`](https://www.npmjs.com/package/md-runbook) (`npx md-runbook run …`), with
provenance. The package holds only `cli.js`, `cli/README.md` and `LICENSE` (laid out by
`scripts/pack-cli.js` in `out/npm`). It has been published since 0.19.2.

It uses npm's **trusted publishing**: no npm token is stored anywhere. npm accepts a publish from
this repository's `release.yml` because the package says so:

- On <https://www.npmjs.com/package/md-runbook/access> (signed in as the package's owner), under
  **Trusted Publisher**, choose **GitHub Actions** and enter organization or user `smojon`,
  repository `md-runbook`, workflow filename `release.yml` (no environment).
- Below it, **Publishing access**: "Require two-factor authentication and disallow tokens" is the
  safest choice once trusted publishing works; it doesn't affect the workflow.

A package must exist before it can have a trusted publisher, so a new package (for example after
a rename) needs one publish with a token first: a granular access token with **Read and write**
for all packages and **Bypass two-factor authentication**, stored as the repository secret
`NPM_TOKEN` and given to the publish step as `NODE_AUTH_TOKEN`. Delete both once the trusted
publisher is set.

To check the package without publishing:
`npm run compile && node scripts/pack-cli.js && (cd out/npm && npm pack --dry-run)`.

### Repository

- The Marketplace page shows the README. Its screenshots use relative paths, which `vsce`
  rewrites to `https://github.com/smojon/md-runbook/raw/HEAD/...`, so they only display when the
  repository is **public** and the images are on the default branch.
- The extension name `md-runbook` must be free on both stores. If it is taken, change `name`
  (and optionally `displayName`) in `package.json`.

## Releasing a version

1. Update `version` in `package.json` (and `package-lock.json`: `npm version 0.1.1 --no-git-tag-version`).
2. Add a `## 0.1.1` section at the top of `CHANGELOG.md` (it becomes the GitHub release notes).
3. Commit, then tag and push:

   ```sh
   git tag v0.1.1
   git push origin main v0.1.1
   ```

The workflow fails early if the tag does not match `package.json`. While the version is below
1.0 the extension is marked **Preview** on the Marketplace (`"preview": true`).

## Manual publishing (if needed)

```sh
npm ci
npx vsce package
npx vsce publish -p <VSCE token>
npx ovsx publish md-runbook-0.1.0.vsix -p <Open VSX token>
```

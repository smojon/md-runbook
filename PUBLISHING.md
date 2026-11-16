# Publishing

Releases are published by GitHub Actions (`.github/workflows/release.yml`) when a version tag is
pushed. The workflow:
1. runs the full test matrix (Windows, macOS, Linux);
2. packages the extension;
3. publishes it to **npm**, **Open VSX** (if its token secret is set) and the **Visual Studio
   Marketplace** (if trusted publishing is turned on, see below);
4. creates a GitHub pre-release with all its files at once (releases are immutable once
   published):
   - the `.vsix`, the command line's `.tgz` and the signed `.apk`;
   - md-runbook-gate for servers: `md-runbook-gate-<os>-<arch>` and `SHA256SUMS`.

## One-time setup

The publishing secrets live in the GitHub environment `release`, not in the repository. See
[Release environments](#release-environments).

### Visual Studio Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create a
   **publisher** with the ID `smojon`. This ID is the `publisher` field in `package.json`; change
   that field if you pick another ID.
2. On the publisher's page, open **Trusted Publishing** and create a policy:
   - repository owner `smojon`, repository `md-runbook`;
   - workflow `release.yml`, environment `release-marketplace` (not `release`: see
     [Release environments](#release-environments)).
3. Set the repository variable `MARKETPLACE_TRUSTED_PUBLISHING` to `true`.
   - No token: `vsce publish --oidc` trades the job's OIDC token for one that lives 15 minutes.
   - In a private repository the policy lapses unless it is used within 48 hours (this one is
     public).
   - Azure DevOps personal access tokens (`VSCE_PAT`) are retired on 1 December 2026.

### Open VSX (VSCodium, Cursor, Gitpod, openvscode-server)

1. Sign in at <https://open-vsx.org> with GitHub, accept the publisher agreement, and create an
   access token under **Settings → Access Tokens**.
2. Create the namespace once (it must match the publisher). `ovsx` reads the token from
   `OVSX_PAT`, so it stays off the command line:
   `read -rsp 'Open VSX token: ' OVSX_PAT && export OVSX_PAT && npx ovsx create-namespace smojon`
3. Add the token as the secret `OVSX_PAT` in the environment `release`.

### npm (the command-line runner)

The Release workflow also publishes the command line as the npm package
[`md-runbook`](https://www.npmjs.com/package/md-runbook) (`npx md-runbook run …`), with
provenance. The package holds only `cli.js`, `cli/README.md` and `LICENSE` (laid out by
`scripts/pack-cli.js` in `out/npm`). It has been published since 0.19.2.

It uses npm's **trusted publishing**: no npm token is stored anywhere. npm accepts a publish from
this repository's `release.yml` because the package says so:

- On <https://www.npmjs.com/package/md-runbook/access> (signed in as the package's owner), under
  **Trusted Publisher**, choose **GitHub Actions**. Enter:
  - organization or user `smojon`;
  - repository `md-runbook`;
  - workflow filename `release.yml`;
  - environment name `release`.
- Set the environment name before the next tag. The npm job runs in the environment `release`.
  npm's docs don't say a blank field still matches, and one guide reports a rejection.
- Under **Publishing access**, **Require two-factor authentication and disallow tokens** is the
  safest choice once trusted publishing works. It doesn't affect the workflow.
- The publish runs with `--ignore-scripts`. The job fails unless `out/npm/package.json` has
  exactly the keys `scripts/pack-cli.js` writes (no `scripts`, no `publishConfig`). Change
  both together.

A package must exist before it can have a trusted publisher. So a new package (for example after
a rename) needs one publish with a token first:

- Use a granular access token with **Read and write** for that package and **Bypass two-factor
  authentication**.
- Give the token an expiry of one day: it is needed for one publish only.
- Store it as the secret `NPM_TOKEN` in the environment `release`. The publish step reads it as
  `NODE_AUTH_TOKEN`.
- Delete the secret and the token once the trusted publisher is set.

To check the package without publishing:
`npm run compile && node scripts/pack-cli.js && (cd out/npm && npm pack --dry-run)`.

### Android app signing key

The App APK workflow (`.github/workflows/app-apk.yml`) signs the Android app with one key, and
its APK is in each version's release (the Release workflow calls it).

- Secrets: `ANDROID_KEYSTORE_BASE64` (the PKCS12 keystore, base64) and
  `ANDROID_KEYSTORE_PASSWORD`. The alias is `md-runbook`.
- Certificate SHA-256 (pinned in the workflow):
  `CC:EE:87:05:39:E6:4E:C1:1E:08:ED:A8:91:D9:EA:C9:36:2E:0E:29:4A:5D:EF:89:C8:AE:B5:34:27:AE:CE:30`.
- Keep an offline copy of the keystore and its password. A lost key means installed apps can
  never be updated.
- The key never shares a job with the build. The `sign` job installs nothing, and it runs only
  for `v*` tags and `main`, in the environment `android-signing`.
- On tags and `main` the build restores no npm or Gradle cache.
- The Release workflow passes only these two secrets to `app-apk.yml`, by name. It doesn't
  inherit the others.
- A secret passed by name works as a repository secret and as an environment secret
  ([Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)).
  So moving them needs no workflow change.
- Recommended: move both secrets into the environment `android-signing`, and allow only `v*`
  tags and `main` to use it.

### Release environments

- Set up environments as in
  [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- The npm and Open VSX jobs run in the environment `release`. It holds `OVSX_PAT` and allows
  only `v*` tags.
- The Marketplace job runs in its own environment, `release-marketplace`, also `v*` tags only.
  - npm and the Marketplace need no secret: both use trusted publishing (OIDC).
  - A trusted publisher checks the workflow and the environment, not the job. Two OIDC jobs in one
    environment could each get the other registry's publish token.
- A repository secret is readable by every workflow on every branch. Delete `OVSX_PAT` there
  once it is in `release`.
- Each publishing job holds one credential and runs none of the repository's dependencies.
  The tools are locked in `scripts/publish-tools` and installed without install scripts.
- The publishing jobs take the packaged files by artifact ID, outside the checkout. They check
  the file list before publishing.
- On Google Play, give this key as the app signing key ("provide a copy of your app signing
  key", see [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)),
  and make a separate upload key. Play takes an `.aab`, not this APK.

### Repository

- The Marketplace page shows the README. Its screenshots use relative paths, which `vsce`
  rewrites to `https://github.com/smojon/md-runbook/raw/HEAD/...`. So they only display when the
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

`vsce` reads its token from `VSCE_PAT`, `ovsx` from `OVSX_PAT`. Type them at a hidden prompt,
so they stay out of the shell history and the process list:

```sh
npm ci
npx vsce package
read -rsp 'Marketplace token: ' VSCE_PAT && export VSCE_PAT
npx vsce publish
read -rsp 'Open VSX token: ' OVSX_PAT && export OVSX_PAT
npx ovsx publish md-runbook-0.1.0.vsix
unset VSCE_PAT OVSX_PAT
```

In PowerShell, set each one with `$env:VSCE_PAT = Read-Host -MaskInput` (PowerShell 7.1 or later) instead.

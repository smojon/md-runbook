# Command line: run runbooks in CI, on servers, on a schedule

`md-runbook run` runs a runbook without VS Code. It uses the same parser, shells, cell options,
checks, retries, redaction and output format as the extension, and writes the outputs into the
file the same way. So a runbook you step through in VS Code also runs unchanged in GitHub
Actions, GitLab, Azure DevOps, Jenkins, cron or Task Scheduler.

```sh
md-runbook run deploy.md --param TARGET=staging --report report.html --junit junit.xml
```

It runs the code blocks in order and stops at the first failed step. It exits with:

| Code | Meaning |
|---|---|
| `0` | every step passed (or was skipped) |
| `1` | a step failed, or could not run (see below) |
| `2` | wrong usage (unknown option, missing file) |

## Getting it

It needs Node.js 20 or newer and nothing else (one bundled file).

- **npm:** `npx md-runbook run runbook.md`, or `npm install -g md-runbook` (published with each
  release once the npm package is set up; see `PUBLISHING.md`).
- **GitHub Actions:** the [action](#github-action) builds it from its own source at the version
  you pin.
- **From a clone:**

  ```sh
  git clone https://github.com/smojon/md-runbook && cd md-runbook
  npm ci && npm run compile
  node out/dist/cli.js run path/to/runbook.md
  ```

## Options

| Option | |
|---|---|
| `--check` | Run, but don't write the outputs into the file. |
| `--out FILE` | Write the runbook with its outputs to `FILE` instead of in place. |
| `--report FILE.html` | Also write the HTML report (the same as **Export Report (HTML)**). |
| `--pdf FILE.pdf` | Also write the report as PDF (see [PDF](#pdf)). |
| `--browser PATH` | The browser for `--pdf`. |
| `--junit FILE.xml` | Also write a JUnit report, one test case per step, for your CI's test view. |
| `--json FILE.json` | Also write the results as JSON: per step its number, line, status (`passed`, `failed`, `skipped`, `not run`), exit, message and (redacted) output. |
| `--param NAME=VALUE` | Value for `${param:NAME}` (repeatable). Without it, the front matter's default is used. |
| `--input NAME=VALUE` | Value for `${input:NAME}` (repeatable). Without it, the environment variable `NAME`. |
| `--yes` | Run blocks that ask for a confirmation in VS Code: risky commands and the `confirm` option. |
| `--keep-going` | Carry on after a failed step (the exit code is still `1`). |
| `--session` / `--isolated` | One shell process per shell for the whole runbook (like [session mode](session.md)), or one per block. Default: the front matter's `mode:`, else isolated. |
| `--timeout SECONDS` | Default timeout per block. The front matter's `timeout:` and a block's `timeout=` win. |
| `--bash PATH`, `--pwsh PATH` | The shells to use (default: as in the extension, e.g. Git Bash on Windows). |
| `--notify URL` | Post a summary to a chat webhook when the run fails (see [Notifications](#notifications)). Prefer the environment variable `MD_RUNBOOK_NOTIFY_URL`. |
| `--notify-on WHEN` | `failure` (default) or `always`; or `MD_RUNBOOK_NOTIFY_ON`. |
| `--quiet` | Print only the summary line. |

## Checking without running

`md-runbook lint file.md…` checks runbooks without running anything; see
[Checking runbooks](lint.md).

## Signing runbooks

`md-runbook sign file.md --key KEY` signs a runbook for servers that run md-runbook-gate, and
`md-runbook verify file.md [--allowed-signers FILE]` shows what a signature covers and which
blocks changed since; see [Signed runbooks](signed-runbooks.md).

| Option of `sign` | Meaning |
| --- | --- |
| `--key KEY` | Private key, or a `.pub` whose key is in the SSH agent (`ssh-keygen -Y sign`) |
| `--signer NAME` | Name shown as the signer (default: the key's comment) |
| `--name NAME` | Runbook name, e.g. `ops/restart-api` (default: the file name) |
| `--version N` | Version (default: the previous one + 1, else 1) |
| `--expires DATE`, `--expires-in DAYS` | Last day it may run (UTC) |
| `--scope NAME` | Where it may run (repeatable) |
| `--pattern NAME=RE` | What `${param:NAME}` may be: a POSIX extended regex for the whole value |
| `--out FILE` | Write the signed runbook to FILE instead |

## What runs, what doesn't

- **Placeholders** never prompt. `${secret:NAME}` and `${input:NAME}` come from the environment
  variable `NAME` (`--input` wins for inputs). Every secret value the runbook references is
  known before the first step, so it is redacted even from a step that prints the environment
  before the step that uses it. A block with `capture-secret=` prints its output only when it
  has finished, redacted (a CI log can't be corrected afterwards). `${param:NAME}` comes from `--param` or the front
  matter's default. `${out:NAME}` comes from an earlier block's [capture=](checks.md). A missing
  value makes the step fail with a message that says what to pass. Secret values are redacted
  from everything printed and written, as are the default redaction patterns.
- **Risky commands** (the default confirmation patterns: `rm -rf`, `delete`, `--force`, …) and
  blocks with `confirm` are **not run without `--yes`**: they are recorded as `exit=declined` and
  the run stops. `no-confirm` can't switch this off.
- **Proposed or assistant-written cells** never run from the command line: they need approval
  and read-only credentials, which only the extension provides.
- **Cell options** work as in the extension: `skip`, `cwd=`, `timeout=`, `env.X=`,
  `continue-on-error`, `name=`, `expect=`, `retry=`, `capture=`, and `os=` (a block for another
  OS is passed over and keeps its output). `terminal` cells run normally (there is no terminal to
  answer prompts in).
- Interactive prompts get end-of-input, as in VS Code without terminal mode.

## In CI

Any CI system: run `npx md-runbook run …` (or `node …/cli.js run …`) as a step, pass secrets
as environment variables, and keep the runbook and reports as artifacts.

### GitHub Action

```yaml
jobs:
  smoke:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: smojon/md-runbook@v0.9.0
        with:
          runbook: runbooks/smoke.md
          params: |
            TARGET=staging
          report: report.html
          pdf: report.pdf
          junit: junit.xml
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}   # for ${secret:API_TOKEN}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: runbook-${{ matrix.os }}
          path: |
            runbooks/smoke.md
            report.*
            junit.xml
```

| Input | |
|---|---|
| `runbook` | The runbook, relative to the workspace (required). |
| `params`, `inputs` | `NAME=VALUE` lines for `${param:…}` / `${input:…}`. |
| `yes`, `keep-going` | `true` for `--yes` / `--keep-going`. |
| `write` | `false` for `--check` (default `true`: the outputs go into the runbook in the workspace). |
| `out`, `report`, `pdf`, `junit` | Files to write (folders are created). |
| `session` | `true` / `false` for `--session` / `--isolated` (default: the front matter). |

The action builds the runner from its own source at the ref you pin (`@v0.3.0`, or a commit
SHA), so nothing is downloaded from a package registry. Inputs reach it through environment
variables, never through a shell command line. On GitHub Actions the runner also adds a table of
the steps to the job summary. This repository's CI runs
[`examples/ci.runbook.md`](../../examples/ci.runbook.md) with it on all three systems.

Use `os=` blocks for the steps that differ per system.

To run a runbook from the GitHub web UI with a button, see [Runbooks on the web](web.md).

The CI system still provides triggers, runners, secrets and artifacts; the runbook provides
the steps, their checks, and a readable record of the run.

## Notifications

With `MD_RUNBOOK_NOTIFY_URL` set (or `--notify URL`), a failed run posts a short message to that
webhook: which steps failed and why, and on GitHub Actions a link to the run. With
`MD_RUNBOOK_NOTIFY_ON=always` (or `--notify-on always`) it also posts when everything passed.

```text
✗ health.md: 1 of 5 steps failed or did not run
• Step 3 (line 20) failed: check failed: the output does not contain "Running"
https://github.com/acme/ops/actions/runs/123456
```

The message format follows the webhook: **Slack** (`hooks.slack.com`), **Microsoft Teams**
(a Workflows "post to a channel when a webhook request is received" flow: `*.logic.azure.com`,
`*.powerplatform.com`), **Discord** and **Google Chat**. Any other URL gets `{"text": "…"}` as
JSON (Mattermost, Rocket.Chat and most others take that).

- The URL is a secret (whoever has it can post to your channel): keep it in a CI secret and pass
  it through the environment. A command-line option can show up in process lists and logs.
  md-runbook never prints it, also not in error messages, removes `MD_RUNBOOK_NOTIFY_URL` from
  the environment the cells get, and redacts the URL from outputs and reports. This protects
  against accidents (`env`, `set -x`), not against a hostile runbook, which runs as your user
  and could find it elsewhere: only notify from runbooks you trust.
- It must be `https` (`http` only for `localhost`).
- Step outputs are not sent, only the step numbers, lines and the reason they failed.
- If the message can't be sent, the run says so; its exit code doesn't change.

For a ready-made scheduled check (a morning health check that posts on failure), see
[`examples/github/scheduled-check.yml`](../../examples/github/scheduled-check.yml).

## PDF

`--pdf report.pdf` prints the HTML report with a Chromium-based browser that is already
installed: Google Chrome, Microsoft Edge (on every Windows machine) or Chromium. Chrome is
preinstalled on GitHub's runners. It runs headless with a throwaway profile, so a browser you
have open is not touched. Point to a browser with `--browser PATH` or the `CHROME_PATH`
environment variable. If none is found, the run says so and exits with `1`; the other reports
are still written.

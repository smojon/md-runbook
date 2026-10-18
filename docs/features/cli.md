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

The runner is built with the extension, as `out/dist/cli.js` (Node.js 20 or newer, no other
dependencies):

```sh
git clone https://github.com/smojon/md-runbook && cd md-runbook
npm ci && npm run compile
node out/dist/cli.js run path/to/runbook.md
```

An npm package (`npx md-runbook run …`) is planned.

## Options

| Option | |
|---|---|
| `--check` | Run, but don't write the outputs into the file. |
| `--out FILE` | Write the runbook with its outputs to `FILE` instead of in place. |
| `--report FILE.html` | Also write the HTML report (the same as **Export Report (HTML)**). |
| `--pdf FILE.pdf` | Also write the report as PDF (see [PDF](#pdf)). |
| `--browser PATH` | The browser for `--pdf`. |
| `--junit FILE.xml` | Also write a JUnit report, one test case per step, for your CI's test view. |
| `--param NAME=VALUE` | Value for `${param:NAME}` (repeatable). Without it, the front matter's default is used. |
| `--input NAME=VALUE` | Value for `${input:NAME}` (repeatable). Without it, the environment variable `NAME`. |
| `--yes` | Run blocks that ask for a confirmation in VS Code: risky commands and the `confirm` option. |
| `--keep-going` | Carry on after a failed step (the exit code is still `1`). |
| `--session` / `--isolated` | One shell process per shell for the whole runbook (like [session mode](session.md)), or one per block. Default: the front matter's `mode:`, else isolated. |
| `--timeout SECONDS` | Default timeout per block. The front matter's `timeout:` and a block's `timeout=` win. |
| `--bash PATH`, `--pwsh PATH` | The shells to use (default: as in the extension, e.g. Git Bash on Windows). |
| `--quiet` | Print only the summary line. |

## What runs, what doesn't

- **Placeholders** never prompt. `${secret:NAME}` and `${input:NAME}` come from the environment
  variable `NAME` (`--input` wins for inputs). `${param:NAME}` comes from `--param` or the front
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

GitHub Actions, on all three systems (PowerShell 7 and Git Bash are preinstalled on the
runners):

```yaml
jobs:
  smoke:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node path/to/md-runbook/out/dist/cli.js run runbooks/smoke.md --report report.html --junit junit.xml
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}   # for ${secret:API_TOKEN}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: runbook-${{ matrix.os }}, path: "runbooks/smoke.md\nreport.html\njunit.xml" }
```

On GitHub Actions the runner also adds a table of the steps to the job summary
(`$GITHUB_STEP_SUMMARY`). Use `os=` blocks for the steps that differ per system.

The CI system still provides triggers, runners, secrets and artifacts; the runbook provides
the steps, their checks, and a readable record of the run.

## PDF

`--pdf report.pdf` prints the HTML report with a Chromium-based browser that is already
installed: Google Chrome, Microsoft Edge (on every Windows machine) or Chromium. Chrome is
preinstalled on GitHub's runners. It runs headless with a throwaway profile, so a browser you
have open is not touched. Point to a browser with `--browser PATH` or the `CHROME_PATH`
environment variable. If none is found, the run says so and exits with `1`; the other reports
are still written.

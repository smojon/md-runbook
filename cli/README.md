# md-runbook

Run the shell blocks of a **Markdown runbook** from the command line, in CI, on servers or on a
schedule, and keep their output in the same `.md` file. It is the command-line runner of the
[Markdown Runbook](https://marketplace.visualstudio.com/items?itemName=smojon.md-runbook) VS Code
extension: the same file format, cell options, checks and secret redaction.

```sh
npx md-runbook run deploy.md --param TARGET=staging --report report.html --junit junit.xml
```

````markdown
```bash retry=20 every=15s expect="successfully rolled out"
kubectl rollout status deploy/web --timeout=10s
```
<!-- md-runbook:output start exit=0 ran=2026-10-19T09:12:00+02:00 attempts=3 check=ok -->
```text
deployment "web" successfully rolled out
```
<!-- md-runbook:output end -->
````

- **bash, PowerShell (pwsh or Windows PowerShell) and cmd**, on Windows, macOS and Linux. Blocks
  marked `os=windows` / `os=linux,macos` are alternatives: each system runs its own.
- **Checks and retries:** `expect="text"`, `expect=/regex/`, `expect-exit=N`,
  `retry=10 every=15s`, and values passed between blocks with `capture=NAME` / `${out:NAME}`.
- **No prompts:** `${secret:NAME}` and `${input:NAME}` come from environment variables,
  `${param:NAME}` from `--param` or the front matter. Secrets are redacted from everything
  printed and written.
- **Safe by default:** risky commands (`rm -rf`, `delete`, `--force`, …) don't run without
  `--yes`, and cells proposed or written by an AI assistant never run.
- **Reports:** the filled-in runbook, `--report` (HTML), `--pdf` (with the Chrome or Edge already
  installed), `--junit` (one test case per step), and a job summary on GitHub Actions.
- Exit code `0` when every step passed, `1` when one failed, `2` for wrong usage.

Requires Node.js 20 or newer; no other dependencies. `md-runbook --help` lists every option.
Full documentation:
[docs/features/cli.md](https://github.com/smojon/md-runbook/blob/main/docs/features/cli.md).

On GitHub Actions you can also use the action, which builds the runner from its own source:

```yaml
- uses: smojon/md-runbook@v0.3.0
  with:
    runbook: runbooks/smoke.md
    report: report.html
```

License: MIT.

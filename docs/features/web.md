# Runbooks on the web

A browser can't run shell commands, so "on the web" means one of these:

| You want | Use |
|---|---|
| A **Run button** on the web, results to download or a report page | the GitHub Actions workflow below |
| The **full extension in a browser** | GitHub Codespaces (VS Code in the browser on a cloud machine): install the extension there and everything works, including running cells |
| Runbooks **readable on a docs site** | nothing to do: runbooks are plain Markdown, so MkDocs, Docusaurus, GitHub Pages or a wiki show them; output markers are HTML comments (invisible) and outputs are ordinary text blocks |
| A **report page** of a run | the HTML report (**Export Report**, or the command line's `--report`) is one self-contained file you can publish as is |

vscode.dev and github.dev can open runbooks but can't run them: extensions there run inside the
browser and can't start processes.

## A Run button: GitHub Actions

[`examples/github/run-runbook.yml`](../../examples/github/run-runbook.yml) is a workflow you copy
to `.github/workflows/` in your repository. Then **Actions → Run a runbook → Run workflow** asks
for:

- the runbook (a path in the repository),
- parameters for `${param:NAME}` (`TARGET=staging; REPLICAS=2`),
- the runner (Linux, Windows or macOS),
- whether risky commands may run (`--yes`),
- whether to publish the report to GitHub Pages.

It runs the runbook with the [command line](cli.md) through the md-runbook GitHub Action and
keeps the filled-in runbook, the HTML and PDF report and a JUnit report as the workflow
artifact **runbook-result**. The job summary shows a table of the steps.

### Before you use it

- **Secrets:** map the ones the runbook uses in the action's `env:` (e.g.
  `API_TOKEN: ${{ secrets.API_TOKEN }}` for `${secret:API_TOKEN}`). They are redacted from the
  output and reports.
- **Who can run it:** only people with write access can run a workflow by hand. For runbooks
  that change things, set an `environment:` with required reviewers on the job, so every run
  waits for an approval.
- **GitHub Pages is public**, also for private repositories (except on GitHub Enterprise).
  Reports are redacted, but they still show host names, versions and other details of your
  systems. Publishing is therefore off by default; the artifact is visible only to people who
  can read the repository. To publish, set **Settings → Pages → Source** to **GitHub Actions**
  and tick the box when you run it.
- The runner is a fresh machine with no access to your network unless you give it access (a
  self-hosted runner, a VPN step, cloud credentials). Runbooks that need internal systems
  usually run on a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners).

## Why there is no hosted "run" page

A web page whose buttons run commands needs a server that executes them for remote users:
authentication, per-user secrets, approvals, an audit trail and isolation between runs. CI
systems already provide all of that, which is why the Run button above is a workflow.

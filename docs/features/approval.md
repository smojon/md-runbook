# Proposed cells and approval

A runbook can be a shared interface between you and an AI assistant: the assistant (through
file edits, a chat provider or an agent) only **proposes** cells, and only a human can
**approve** and run them. The state lives in the fence's info string, so it is plain Markdown,
shows up in diffs and survives any editor:

````markdown
```bash proposed by=ai reason="check pod restarts"
kubectl get pods -n shop --sort-by=.status.containerStatuses[0].restartCount
```
````

After approval, the `proposed` flag is replaced by who approved it and when; every other
token is kept:

````markdown
```bash approved-by=smojon approved-at=2026-10-18T17:20:00+02:00 by=ai reason="check pod restarts"
````

## The gate

- A proposed cell is never run. It is recorded as `exit=skipped` with the reason
  `proposed — approve it first`. **Run All** skips it and carries on with the other cells.
- A cell that was approved and then edited needs approval again (`changed since approval`),
  see `mdRunbook.approval.resetOnEdit`.
- An `approved-by=` stamp that came with the file is not trusted by default (anything that
  can edit the file, including an assistant, can write one). The cell runs once the same
  code has been approved on this machine; see `mdRunbook.approval.trustFileApprovals`.
- Approved cells record the audit trail in their output marker:

  ```markdown
  <!-- md-runbook:output start exit=0 ran=… ended=… duration=0.312s proposed-by=ai approved-by=smojon -->
  ```

## Approving and rejecting

Proposed cells show `🛡 Proposed by ai · ✓ Approve · 🗑 Reject` in their cell status bar, and
the status bar shows `🛡 2 proposals` for the active runbook (click it to go to the next one).

| Command | Effect |
| --- | --- |
| **md-runbook: Approve Proposed Cell** | Approve the selected cells (or the cell whose status bar item was clicked), after the policy check below. |
| **md-runbook: Reject Proposed Cell** | Delete the proposed cell. It's a normal edit: **Undo** brings it back. |
| **md-runbook: Approve All Proposals** | Approve every proposal in the runbook, one by one, each through the policy check. |
| **md-runbook: Go to Next Proposal** | Select and reveal the next cell waiting for approval. |

Approving changes only the cell's opening fence line; save the runbook to write it. The name
recorded is your OS user name, or `mdRunbook.approval.userName`.

## Command policy

Cells proposed by an assistant (`by=` present) are checked against a command policy before
they can be approved. Each command line is evaluated (comments and blank lines ignored, line
continuations `\`, `` ` `` and `^` joined, CRLF and LF alike):

| Result | When | Approve does |
| --- | --- | --- |
| **denied** | any line matches a `deny` pattern | Refuses, with the line and the pattern. Edit the cell instead. |
| **allowed** | every command on every line (split at `\|`, `;`, `&&`, `\|\|`, `&`) matches an `allow` pattern | Approves directly. |
| **review** | anything else | A dialog lists the commands that are not on the allowlist; with `requireTypedConfirmation` you then have to type `run`. |

Command substitution (`$(…)`, backticks, `<(…)`), redirection to a file (`>`) and
`${secret:…}` / `${input:…}` references always need review. Fence options that change how the
cell runs (`no-confirm`, `cwd=`, `env.*`, `timeout=`, `continue-on-error`) are listed in the
review dialog too.

A policy file `.md-runbook-policy.json` is looked up next to the `.md` file, then in parent
folders up to the workspace folder (the first one found wins). Because anyone who can change the
repository controls that file, it can only make the built-in policy **stricter**: its `deny`
rules are added to the built-in ones, its `allow` list can only narrow the built-in one (a command
must match both), and `requireTypedConfirmation` stays on. To replace the policy entirely, point
`mdRunbook.approval.policyFile` (a user setting) at a file outside the workspace.

```json
{
  "allow": ["^kubectl\\s+(get|describe|logs)\\b", "^make\\s+status$"],
  "deny": ["\\|\\s*(ba)?sh\\b", "\\bkubectl\\b.*\\sdelete\\b"],
  "requireTypedConfirmation": true
}
```

- Patterns are case-insensitive JavaScript regular expressions; start one with `(?-i)` to make
  it case-sensitive. `allow` patterns are matched against each command (anchor them with `^`),
  `deny` patterns against the whole line.
- A key that is present replaces the built-in list for that key; a missing key keeps it.
  Invalid JSON or patterns are reported and the built-in values are used.

Built-in **allow**: read-only `kubectl` / `oc` (`get`, `describe`, `logs`, `top`, `events`,
`explain`, `version`, `api-resources`, `cluster-info`, `whoami`, `status`, `config view`,
`auth can-i`, …), `helm list|status|get|history|show|search|template|lint`, `curl` without a
request body, upload, output file, config file or non-GET method, the PowerShell `Get-*`,
`Test-*`, `Select-*`, `Where-*`, `Sort-*`, `Format-*`, `ConvertTo-*`/`ConvertFrom-*` and
`Write-Output` cmdlets, and `echo`, `printf`, `cat`, `grep`, `head`, `tail`, `jq`, `yq`
(without `-i`), `ls`, `dir`, `pwd`, `whoami`, `date`, `hostname`, `uname`, `wc`, `uniq`,
`cut`, `tr`, `id`, `df`, `ps`, `uptime`, `printenv`.

Built-in **deny**: piping into a shell or interpreter (`| sh`, `| bash`, `| python`, `| pwsh`,
…), `iex` / `Invoke-Expression`, `[scriptblock]::Create`, `base64 -d … |`, `eval`, `sh -c`,
`pwsh -EncodedCommand`, `source <(…)`, `rm -rf /`, `kubectl … delete`, `oc … delete`,
writing to `/dev/…` (other than `/dev/null`, `stdout`, `stderr`, `tty`), `mkfs`, `dd of=` and
fork bombs.

The policy is a guard rail, not a sandbox: it reads the text, so a determined script can hide
what it does. Read what you approve.

## What an approval covers

An approval is bound to the cell's **code**, its **fence options** (`cwd=`, `env.X=`, `timeout=`,
`by=`, …) and the **runbook file**. Changing any of them, or copying the cell into another runbook,
needs a new approval. Approvals are remembered on this machine only; an `approved-by=` stamp
written into the file by someone (or something) else does not count unless
`mdRunbook.approval.trustFileApprovals` is on. A cell with `by=` but no approval is always treated
as a proposal, even if its `proposed` flag was removed.

## Read-only credentials

Cells proposed by an assistant can get their own credentials, for example a kubeconfig with a
read-only service account or a read-only API token:

```json
"mdRunbook.approval.readOnlyEnv": {
  "KUBECONFIG": "${secret:KUBECONFIG_READONLY}",
  "GITHUB_TOKEN": "${secret:GH_READONLY_TOKEN}"
}
```

- `${secret:NAME}` is read from the secret store (**md-runbook: Set Secret**); a missing secret
  fails the cell. Plain values work too (`"KUBECONFIG": "/home/me/.kube/readonly"`).
- The variables are applied last, so they win over `mdRunbook.execution.env`,
  `mdRunbook.secrets.inject`, `.env` files and `env.*` cell options. Their values are redacted
  from live and saved output.
- With `mdRunbook.approval.readOnlyOnly` (the default), a cell with `by=` refuses to run while
  `readOnlyEnv` is empty, with a message saying how to configure it.

## Security defaults

Every default is the secure choice. All approval settings are machine-scoped: they can be set
in your user settings but not in a workspace's `.vscode/settings.json`, which an assistant
could edit.

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.approval.enabled` | `true` | Skip proposed cells until approved. `false` is **insecure**: proposed cells run like any other cell. |
| `mdRunbook.approval.resetOnEdit` | `true` | An approved cell whose code changed needs approval again. |
| `mdRunbook.approval.trustFileApprovals` | `false` | Honour `approved-by=` stamps from the file without approving the same code on this machine. |
| `mdRunbook.approval.policy.enabled` | `true` | Check AI-proposed cells against the command policy before approval. `false` approves them with one click. |
| `mdRunbook.approval.policyFile` | `""` | Policy file; empty = nearest `.md-runbook-policy.json`, else the built-in policy (which has `requireTypedConfirmation: true`). |
| `mdRunbook.approval.readOnlyOnly` | `true` | AI-proposed cells refuse to run unless `readOnlyEnv` is set. |
| `mdRunbook.approval.readOnlyEnv` | `{}` | Environment variables (values may use `${secret:NAME}`) for AI-proposed cells. |
| `mdRunbook.approval.userName` | `""` | Name recorded as `approved-by=`; empty = OS user name. |

## Notes

- Approvals made on this machine are remembered by a hash of the cell's code (in VS Code's
  global state), so reopening the runbook doesn't ask again for unchanged cells.
- Cells without `proposed` / `approved-by=` in their fence (written by you) are not affected.
  Cells added in the notebook editor have no fence options, so they are never proposals.
- Editing a proposed cell keeps it proposed.

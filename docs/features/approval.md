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

- A proposed cell is never run. It is recorded as `exit=proposed` with the reason
  `proposed — approve it first`. **Run All** skips it and carries on with the other cells;
  progress keeps it pending, so **Resume Run** picks it up once it is approved.
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
| **allowed** | every command on every line (split at `\|`, `;`, `&&`, `\|\|`, `&` outside quotes) matches an `allow` pattern and passes the built-in checks below | Approves directly. |
| **review** | anything else | A dialog lists the commands that are not on the allowlist; with `requireTypedConfirmation` you then have to type `run`. |

Lines are split into commands with the cell's shell quoting rules: separators inside `'…'` or
`"…"` don't split (so `grep -E 'CrashLoop|Error'` or a quoted URL with `&` is one command),
escapes count (bash `\`, cmd `^`; cmd has no single quotes), and quotes are removed before
patterns are matched. `.exe` after a command name is ignored (`oc.exe`, `curl.exe`). In
PowerShell, statements inside `{ … }` script blocks (`Where-Object { … }`,
`ForEach-Object { … }`) must be allowed too; expressions such as `$_.CPU -gt 10` are, method
calls and assignments are not.

**Built-in checks** (they apply whatever the policy file says, so even `"allow": [".*"]` can't
make these one-click):

- Command substitution (`$(…)`, backticks, `<(…)`), redirection to a file (`>` outside quotes)
  and `${secret:…}` / `${input:…}` references.
- Reading the environment: `printenv`, `env`, `set`, `export`, `declare`, `typeset`,
  `compgen`, `Get-Variable`, anything with `env:` (`$env:X`, `Get-ChildItem env:`, `dir env:`),
  `[Environment]::…`, `/proc/…/environ`, and reads of variables named like secrets (`$…TOKEN`,
  `${…PASSWORD}`, `%…SECRET%`, `$…API_KEY`, …).
- Credential files: anything mentioning `.kube`, `.ssh`, `.aws`, `.azure`, `.docker`, `.gnupg`,
  `.netrc`, `.git-credentials`, `.config/gcloud`, `.env`, `kubeconfig` (also `$KUBECONFIG`),
  `credential`, `id_rsa` / `id_ed25519`, or `--show-token`.
- `kubectl` / `oc`: the first word after the global flags must be a read verb (`get`,
  `describe`, `logs`, `top`, `events`, `explain`, `version`, `api-resources`, `api-versions`,
  `cluster-info`, `whoami`, `status`, `projects`, `config view|current-context|get-contexts`,
  `auth can-i|whoami`, `adm top`, `adm policy who-can`). Flags that take a value (`-n`,
  `--namespace`, `--context`, `-l`, `-o`, `-c`, …) consume exactly one word, so `oc -n get
  scale …` is not mistaken for `get`. Unknown flags take no value.
- `kubectl` / `oc` / `helm`: any word that changes something (`scale`, `patch`, `apply`,
  `create`, `replace`, `edit`, `set`, `label`, `annotate`, `drain`, `cordon`, `taint`,
  `rollout`, `exec`, `rsh`, `debug`, `cp`, `port-forward`, `proxy`, `run`, `expose`, `adm`,
  `login`, `project`, `new-app`, `start-build`, `tag`, `import`, `upgrade`, `install`,
  `rollback`, `uninstall`, `delete`, …) anywhere in the command; flags that switch credentials
  or server (`--kubeconfig`, `--token`, `--server`, `-s`, `--as`, `--as-group`,
  `--client-key`, helm `--kube-token`, `--kube-apiserver`, …), since they bypass
  `readOnlyEnv`; `get secret(s)` with `-o yaml|json|jsonpath|go-template|custom-columns` or
  `--template`; `whoami -t`; `config view --raw|--flatten`; follow/watch (`logs -f`,
  `--follow`, `-w`, `--watch`).
- Other follow modes and writes: `tail -f`, `Get-Content -Wait`, `date -s`, `yq -i`,
  `sort -o`, `uniq IN OUT`, and PowerShell-style `curl` parameters (`-Method`, `-Body`,
  `-InFile`, `-OutFile`: in Windows PowerShell 5.1 `curl` is `Invoke-WebRequest`).

Fence options that change how the cell runs (`no-confirm`, `cwd=`, `env.*`, `timeout=`,
`continue-on-error`, `retry=`, `every=`, `expect=`, `expect-not=`, `expect-exit=`, `capture=`,
`capture-secret=`) are listed in the review dialog too.

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

Built-in **allow**: `kubectl` / `oc` (read-only per the built-in checks above),
`helm list|status|get|history|show|search|template|lint`, `curl` without a request body,
upload, output file, config file or non-GET method, `Invoke-RestMethod` / `Invoke-WebRequest`
(`irm`, `iwr`) without `-Method`, `-Body`, `-InFile`, `-OutFile`, `-Form` or credentials, the
PowerShell `Get-*`, `Test-*`, `Select-*`, `Where-*`, `Sort-*`, `Format-*`,
`ConvertTo-*`/`ConvertFrom-*`, `ForEach-Object`, `Out-String`, `Select-String` and
`Write-Output` cmdlets (and their aliases), `$name = 'literal'` in PowerShell, and `echo`,
`printf`, `cat`, `type`, `grep`, `findstr`, `head`, `tail`, `jq`, `yq` (without `-i`), `ls`,
`dir`, `pwd`, `whoami`, `date`, `hostname`, `uname`, `wc`, `sort`, `uniq`, `cut`, `tr`, `id`,
`df`, `ps`, `uptime`, `nslookup`, `dig`, `host`, `ping` with a count (`-c N` / `-n N`) and
`openssl x509 -noout` / `openssl s_client` (without output files). `printenv`, `env` and `set`
are no longer allowed.

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

**Cells proposed by an assistant refuse to run until `mdRunbook.approval.readOnlyEnv` is set**
(with `mdRunbook.approval.readOnlyOnly`, the default). Those variables are the only credentials
such a cell gets:

```json
"mdRunbook.approval.readOnlyEnv": {
  "KUBECONFIG": "${secretFile:KUBECONFIG_READONLY}",
  "GITHUB_TOKEN": "${secret:GH_READONLY_TOKEN}"
}
```

- `${secret:NAME}` is replaced by the value stored with **md-runbook: Set Secret**. Use it for
  variables that hold the credential itself (tokens).
- `${secretFile:NAME}` is replaced by the **path** of a temporary file holding the stored value
  (mode 0600, in its own 0700 folder, deleted when the cell finishes). Use it for variables
  that point to a file, such as `KUBECONFIG`.
- A missing secret fails the cell. Plain values work too (`"KUBECONFIG": "/home/me/.kube/readonly"`).
- The environment of a cell with `by=` is rebuilt from scratch: `mdRunbook.execution.env`, the
  cell's own `env.*` options (they are part of what you approved), its `${param:}` and
  non-secret `${input:}` values, then `readOnlyEnv` on top. It gets **no** `.env` file, **no**
  `mdRunbook.secrets.inject`, and a `${secret:…}` or secret `${input:…}` reference fails the
  cell. Values from `readOnlyEnv` secrets are redacted from live and saved output.
- Without another timeout (`mdRunbook.execution.timeoutSeconds` 0 and no `timeout=`), such a
  cell is stopped after `mdRunbook.approval.aiTimeoutSeconds` (default 120 seconds).
- The front matter's `cwd:` and `timeout:` don't apply to it (approval shows the cell's own
  options, not the front matter's): it runs in the `.md` file's folder.
- A value it captures (`capture=`) is not used by your own cells: `${out:NAME}` in a cell of
  yours fails if an assistant cell captured `NAME`, because your cells run with your
  credentials. It may use non-secret values your cells captured.
- In session mode, assistant cells never join the shared shell (see [session](session.md)).

### Example: a read-only OpenShift service account

```bash
oc create sa ai-readonly -n ops
oc adm policy add-cluster-role-to-user view -z ai-readonly -n ops
TOKEN=$(oc create token ai-readonly -n ops --duration=8h)
SERVER=$(oc whoami --show-server)
# A kubeconfig that only holds this token:
KUBECONFIG=/tmp/ai-readonly.kubeconfig oc login --token="$TOKEN" --server="$SERVER"
cat /tmp/ai-readonly.kubeconfig   # copy the contents
rm /tmp/ai-readonly.kubeconfig
```

Run **md-runbook: Set Secret**, name it `KUBECONFIG_READONLY` and paste the kubeconfig
contents, then set `"KUBECONFIG": "${secretFile:KUBECONFIG_READONLY}"` in
`mdRunbook.approval.readOnlyEnv` (user settings). The `view` role can't read Secrets; renew the
token when it expires (`--duration`).

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
| `mdRunbook.approval.readOnlyEnv` | `{}` | The only credentials of AI-proposed cells (values may use `${secret:NAME}` and `${secretFile:NAME}`). |
| `mdRunbook.approval.aiTimeoutSeconds` | `120` | Timeout for AI-proposed cells that would otherwise run without one. 0 = none. |
| `mdRunbook.approval.userName` | `""` | Name recorded as `approved-by=`; empty = OS user name. |

## Notes

- Approvals made on this machine are remembered by a hash of the cell's code (in VS Code's
  global state), so reopening the runbook doesn't ask again for unchanged cells.
- Cells without `proposed` / `approved-by=` in their fence (written by you) are not affected.
  Cells added in the notebook editor have no fence options, so they are never proposals.
- Editing a proposed cell keeps it proposed.

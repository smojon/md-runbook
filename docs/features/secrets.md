# Secrets, inputs, parameters and `.env`

Runbooks often need tokens, passwords or values that differ per run. md-runbook passes all of
them to cells as **environment variables**.

Values are never written into the script text. Secret values are redacted from the live view and
from everything saved to the `.md` file.

## Using a stored secret in a workspace

Stored secrets live in the OS keychain for all of VS Code. The first time a runbook in a workspace
references `${secret:NAME}`, md-runbook asks whether runbooks in that workspace may use it. The
answer is remembered per workspace.

Secrets you enter or store from that workspace are allowed there automatically.

Redaction of secret values works by **exact match**. A script that prints a secret encoded or in
parts is not caught. So only use secrets in runbooks you trust.

## References in cells

Write a reference anywhere in a cell's source:

| Reference | Value comes from |
| --- | --- |
| `${secret:NAME}` | the secret store (OS keychain) |
| `${input:NAME}` | asked once per notebook session |
| `${input:NAME:secret}` | asked once, masked, and redacted |
| `${param:NAME}` | a runbook parameter (front matter), asked once per session |

`NAME` is letters, digits and `_`, not starting with a digit.

Before the cell runs, each reference is replaced with the shell's own syntax for an environment
variable `NAME`. The value is put into that variable:

| Shell | `${secret:TOKEN}` becomes |
| --- | --- |
| bash / sh | `${TOKEN}` |
| PowerShell | `${env:TOKEN}` |
| cmd | `!TOKEN!` (and `@setlocal EnableDelayedExpansion` as the first line) |

So the reference behaves exactly like a variable in that shell. Use it where a variable
would expand: inside double quotes, not single quotes.

```bash
curl -fsS -H "Authorization: Bearer ${secret:API_TOKEN}" "https://${param:HOST}/api/health"
```

```pwsh
oc login --token="${secret:OC_TOKEN}" --server="${param:SERVER}"
```

```cmd
psql "postgresql://app:${input:DB_PASSWORD}@db/app"
```

- **cmd:** references become `!NAME!` (delayed expansion), which cmd expands *after* parsing the
  line. So a value containing `&`, `|`, `<`, `>`, `^` or `%` is never run as cmd syntax.

  A cmd cell with references therefore runs with `@setlocal EnableDelayedExpansion` prepended. In
  such a cell, a literal `!` must be written `^^!`. Cells without references are not changed.
- One name can only be used with one kind in a cell (`${secret:X}` and `${input:X}` together is
  an error).
- The source saved in the file keeps the `${secret:…}` reference; only the copy that runs is
  rewritten.
- The environment variable has the reference's name, so don't use names like `PATH`.

## Secret store

| Command | What it does |
| --- | --- |
| **md-runbook: Set Secret** | Asks for a name and a value (masked) and stores it. |
| **md-runbook: Delete Secret** | Pick a stored secret to delete. |
| **md-runbook: List Secrets** | Shows the stored names (never values). Picking one copies `${secret:NAME}`. |

Values are kept in VS Code's SecretStorage, which uses the OS keychain (Windows Credential
Manager, macOS Keychain, libsecret on Linux). They are available to every runbook. If a cell
references a secret that isn't stored yet, you're asked for its value once and it is stored.

To pass stored secrets to **every** cell without writing a reference, list them in
`mdRunbook.secrets.inject`. Read them as normal environment variables (`$API_TOKEN`,
`$env:API_TOKEN`, `%API_TOKEN%`):

```json
"mdRunbook.secrets.inject": ["API_TOKEN", "OC_TOKEN"]
```

Secret values (stored secrets and secret inputs) are always redacted, even when
`mdRunbook.redaction.enabled` is off. They are redacted from the live view and from saved output,
as exact matches. Values shorter than 4 characters are not redacted.

## Inputs

`${input:NAME}` asks for a value with an input box the first time a cell needs it. Its title shows
the runbook's file name. Later cells of the same runbook reuse the value until the runbook is
closed.

Inputs are masked and redacted when written as `${input:NAME:secret}` or when the name ends in
`_PASSWORD`, `_TOKEN` or `_SECRET`.

Cancelling the input box leaves the cell unanswered: nothing is run, and the run stops there.
**Resume Run** asks again.

**When you're asked.** The input box is VS Code's own and opens at the top of the window. So
md-runbook asks before the cell starts (it shows as queued, its timer not running).

While the box is open, md-runbook says so:

- on the cell's status line;
- in the status bar, in yellow: **Waiting for you: input NAME**. Click it to show the cell.

The box's title names the cell.

At the click, before anything runs, **Run All** asks for the inputs and parameters of all its
cells. So does any run of several cells. Escape there cancels the run.

With `mdRunbook.execution.launchForm` on (the default), Run All first opens the launch form in
the Steps view instead. There you fill them all in at once ([progress](progress.md#steps-view)).
Not asked up front: the setup, ready check and teardown, skipped cells and cells for another OS
or host.

(For the box in the middle of the window, pick *Quick Input Position: Center* in VS Code's
Customize Layout.)

**The value you used last time is filled in.** For a parameter or an input that isn't secret,
the box opens with the value last given for that runbook. It says when:
`Value for REGION (last used yesterday; Enter keeps it)`.

That last value is kept in the workspace, never for a secret or masked input.

Enter takes it again; typing replaces it. A parameter never given before shows its default. The
app does the same in the card that asks for values.

**md-runbook: Set Inputs** asks for every input the runbook uses, with the current value filled
in. Use it to set or change them before running. A secret input is masked and never shown;
leaving it empty keeps the current value.

**md-runbook: Reset Inputs** forgets the inputs and parameter values of the active runbook, so
they are asked again.

## Runbook parameters

Declare parameters in front matter at the very top of the `.md` file:

```markdown
---
title: Deploy
params:
  - NAMESPACE
  - REGION: eu-west-1
  - REPLICAS: "3"
  - TARGET: staging  # Where to deploy. One of: staging, prod.
---

# Deploy
```

Each item is `- NAME` or `- NAME: default`; other keys are ignored. The first time a cell uses
`${param:NAME}`, you're asked for it with the default filled in. **md-runbook: Set Parameters**
asks for all of them at once (the declared ones and any other the cells use).

Values last until the runbook is closed or **Reset Inputs** is run. With
`mdRunbook.params.useDefaults` on, parameters that have a default are not asked for. Parameters
are not secret and not redacted.

**Descriptions and choices.** A comment after the item (`# …`) describes the parameter. A
trailing `One of: a, b, c` in it lists the values allowed.

The launch form ([progress](progress.md#steps-view)) shows the description under the field.
When there are choices, it shows a list to pick from, and **Start** takes only one of them.

The input boxes show the description too, and take only one of the choices. The linter warns
when the default is not one of the choices.

A value from anywhere else must be one of the choices too, or the step doesn't run:

- a runbook link or alert (VS Code doesn't take it, and asks instead);
- a runbook call, the default, or `--param` on the command line (an error before anything runs).

Front matter is plain Markdown to md-runbook; it is saved byte for byte like everything else.

## `.env` files

Set `mdRunbook.execution.envFile` to load `KEY=VALUE` lines into every cell's environment:

```json
"mdRunbook.execution.envFile": ".env"
```

```sh
# .env
export API_URL=https://staging.example.com
DB_PASSWORD="p@ss w0rd"   # double quotes allow \n, \t, \" escapes
LABEL='literal $text'
```

- Relative paths are relative to the cell's working folder: the runbook's folder, unless `cwd:`
  or `cwd=` set another. `${workspaceFolder}` is expanded (to that folder if no folder is open).
  A missing file is ignored.
- `#` comments, an `export ` prefix, and single or double quotes are supported. Variable
  expansion and multi-line values are not.
- With `mdRunbook.redaction.redactKnownSecrets` (on by default), values that look like secrets
  are redacted as exact matches:
  - values of credential-like keys (`*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*PASSWD*`, `*_KEY`,
    `*_KEY_*`, `*APIKEY*`, `*CREDENTIAL*`, `*PRIVATE*`, `*_AUTH`, `*COOKIE*`, `*SESSION*`,
    `*_DSN`, connection strings);
  - URLs with a password (`scheme://user:pass@host`);
  - long random-looking values (16+ characters, letters and digits, high entropy), whatever
    their key.

  Plain settings such as `REGION=eu-west-1` are not redacted, so they don't mangle unrelated
  output for the rest of the session. Trivial values (`true`, `false`, `yes`, `no`, `on`, `off`,
  numbers up to 5 digits) are never redacted. Name secret keys accordingly, or store them with
  **Set Secret** instead.

Environment variables are applied in this order (later wins):

1. the front matter's `env:`;
2. `mdRunbook.execution.env`;
3. the `.env` file;
4. the cell's own `env.NAME=` options;
5. `mdRunbook.secrets.inject`;
6. references in the cell.

A `kube-context-mode: pin` runbook's `KUBECONFIG` and `git-bash-path-conversion: off` go on top.

**Tools installed by the runbook.** Cells inherit VS Code's `PATH`, read once when VS Code
started.

- On Windows, each cell also gets the `PATH` folders added to the registry since then. So a step
  can install Git or uv with `winget`, and the next step can use it. The folders are appended, so
  the inherited order wins; `mdRunbook.execution.refreshPath` turns it off.
- On macOS and Linux, most installers write into a folder that is already on the `PATH`. When one
  adds a new folder through your shell profile (uv, cargo, nvm), restart VS Code. Or start the
  cell with `export PATH="$HOME/.local/bin:$PATH"`.

**Cells written by an assistant** (`by=` in the fence) get none of this:

- no `.env` file;
- no `mdRunbook.secrets.inject`;
- a `${secret:…}` or secret `${input:…}` reference fails the cell with a message.

Their environment is rebuilt from:

- `mdRunbook.execution.env`;
- their own `env.*` options;
- the values of their `${param:}`, non-secret `${input:}` and `${out:}` references;
- `mdRunbook.approval.readOnlyEnv` on top (see [approval](approval.md#read-only-credentials)).

The front matter's `env:` is then added under it, as for any cell.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.secrets.inject` | `[]` | Stored secrets passed to every cell as environment variables. |
| `mdRunbook.execution.envFile` | `""` | `.env` file loaded into every cell's environment (e.g. `.env`, `${workspaceFolder}/.env`). |
| `mdRunbook.execution.refreshPath` | `true` | Windows: add the `PATH` folders installed since VS Code started to each cell and new session. |
| `mdRunbook.redaction.redactKnownSecrets` | `true` | Redact the `.env` file's values from live and saved output. |
| `mdRunbook.params.useDefaults` | `false` | Use front-matter defaults without asking. |

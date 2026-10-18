# Secrets, inputs, parameters and `.env`

Runbooks often need tokens, passwords or values that differ per run. md-runbook passes all of
them to cells as **environment variables**. Values are never written into the script text, and
secret values are redacted from the live view and from everything saved to the `.md` file.

## References in cells

Write a reference anywhere in a cell's source:

| Reference | Value comes from |
| --- | --- |
| `${secret:NAME}` | the secret store (OS keychain) |
| `${input:NAME}` | asked once per notebook session |
| `${input:NAME:secret}` | asked once, masked, and redacted |
| `${param:NAME}` | a runbook parameter (front matter), asked once per session |

`NAME` is letters, digits and `_`, not starting with a digit. Before the cell runs, each
reference is replaced with the shell's own syntax for an environment variable `NAME`, and the
value is put into that variable:

| Shell | `${secret:TOKEN}` becomes |
| --- | --- |
| bash / sh | `${TOKEN}` |
| PowerShell | `${env:TOKEN}` |
| cmd | `%TOKEN%` |

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

- **cmd:** `%NAME%` is expanded before cmd parses the line, so a value containing `&`, `|`,
  `<`, `>` or `^` is interpreted by cmd. Put the reference inside double quotes (`"${secret:X}"`).
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
`mdRunbook.secrets.inject`; read them as normal environment variables (`$API_TOKEN`,
`$env:API_TOKEN`, `%API_TOKEN%`):

```json
"mdRunbook.secrets.inject": ["API_TOKEN", "OC_TOKEN"]
```

Secret values (stored secrets and secret inputs) are always redacted from the live view and
from saved output as exact matches, even when `mdRunbook.redaction.enabled` is off. Values
shorter than 4 characters are not redacted.

## Inputs

`${input:NAME}` asks for a value with an input box (its title shows the runbook's file name) the
first time a cell needs it; later cells of the same runbook reuse the value until the runbook is
closed. Inputs are masked and redacted when written as `${input:NAME:secret}` or when the name
ends in `_PASSWORD`, `_TOKEN` or `_SECRET`.

Cancelling the input box fails the cell with `input NAME cancelled`; nothing is run. Run All
stops there as with any failure.

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
---

# Deploy
```

Each item is `- NAME` or `- NAME: default`; other keys are ignored. The first time a cell uses
`${param:NAME}`, you're asked for it with the default filled in. **md-runbook: Set Parameters**
asks for all declared parameters at once. Values last until the runbook is closed or
**Reset Inputs** is run. With `mdRunbook.params.useDefaults` on, parameters that have a default
are not asked for. Parameters are not secret and not redacted.

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

- Relative paths are relative to the runbook's folder; `${workspaceFolder}` is expanded (to
  the runbook's folder if no folder is open). A missing file is ignored.
- `#` comments, an `export ` prefix, and single or double quotes are supported. Variable
  expansion and multi-line values are not.
- With `mdRunbook.redaction.redactKnownSecrets` (on by default), every value from the file is
  redacted as an exact match, except trivial ones (`true`, `false`, `yes`, `no`, `on`, `off`,
  numbers up to 5 digits) that would otherwise mangle unrelated output.

Environment variables are applied in this order (later wins): `mdRunbook.execution.env`, the
`.env` file, `mdRunbook.secrets.inject`, references in the cell.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.secrets.inject` | `[]` | Stored secrets passed to every cell as environment variables. |
| `mdRunbook.execution.envFile` | `""` | `.env` file loaded into every cell's environment (e.g. `.env`, `${workspaceFolder}/.env`). |
| `mdRunbook.redaction.redactKnownSecrets` | `true` | Redact the `.env` file's values from live and saved output. |
| `mdRunbook.params.useDefaults` | `false` | Use front-matter defaults without asking. |

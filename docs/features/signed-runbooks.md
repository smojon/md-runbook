# Signed runbooks (design)

**Status:** proposal, not built. Comments welcome before any code.

## Goal

An ops team publishes runbooks. A support team runs them on servers from the app. A server set
up for this runs only those published runbooks, unchanged, for the support team's accounts.

The server's owner decides. Without the gate, or with the gate set to allow unsigned runbooks,
any runbook runs, as it does today.

## Why the server decides

The app could refuse unsigned runbooks, but the support engineer's SSH key also works with plain
`ssh server 'anything'`. A check in the client only prevents accidents. The check that holds is
on the server: the account's key may only start one program, the **gate**, and the gate decides
what runs.

```
publisher                      support engineer               server
md-runbook sign  ──.md file──▶ app ──SSH (any command)──────▶ sshd: forced command
(signature in the file)                                       └▶ md-runbook-gate
                                                                 verify, check policy,
                                                                 run cells, log
```

## What exists already

- **Azure Automation:** Hybrid Runbook Workers can be set to run only signed runbooks (GPG on
  Linux). It is the same idea, but tied to Azure and its agent on each machine.
- **Rundeck, AWX, StackStorm:** support teams run predefined jobs with access rules and an
  audit log. A central server holds the jobs and the credentials, and it has to be installed
  and run.
- **PowerShell `AllSigned`:** runs signed scripts only. It is a client setting, and Microsoft
  itself says execution policy is not a security boundary.
- **Forced-command wrappers:** an old SSH technique (rrsync, gitolite). Each wrapper allows a
  fixed list of commands, so every new command means changing the wrapper on every server.

What is new here: the runbook stays a Markdown file that you read and run, the server needs one
script and a list of signers, and a new release reaches every server without being deployed to
them, because the signature carries the trust.

## Server setup

The support key may only start the gate (`restrict` also turns off port, agent and X11
forwarding and the pty):

```
# ~/.ssh/authorized_keys of the account the support team uses
restrict,command="/usr/local/bin/md-runbook-gate" ecdsa-sha2-nistp256 AAAA… alice@support
restrict,command="/usr/local/bin/md-runbook-gate --unsigned=allow" ssh-ed25519 AAAA… bob@ops
```

With SSH certificates, the CA puts the same restriction in each certificate, and the servers
need no `authorized_keys` edits:
`ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

The trusted publishers, in OpenSSH's own `allowed_signers` format:

```
# /etc/md-runbook/allowed_signers
ops@example.net namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA…
release-ci@example.net namespaces="md-runbook",valid-before="20270101" ssh-ed25519 AAAA…
```

The policy:

```
# /etc/md-runbook/gate.conf
unsigned = refuse          # refuse | allow
revoked  = /etc/md-runbook/revoked     # manifest hashes, one per line
log      = syslog          # or a file path
```

## Unsigned runbooks

The server's owner chooses, per server and per key:

| Setup | Unsigned runbooks | What you get |
| --- | --- | --- |
| No gate (today) | run | Full shell access for the key. |
| Gate, `unsigned = allow` | run | No interactive shells or forwarding, and every cell is logged with a hash of its code. Signed runbooks still show who signed them. |
| Gate, `unsigned = refuse` (default) | refused | Only runbooks signed by `allowed_signers`. |
| `--unsigned=allow` or `--unsigned=refuse` on a key's line | per key | Overrides `gate.conf` for that key, for example ops may, support may not. |

Before running anything, the app asks the gate for its policy. If the server takes only signed
runbooks, the app says so ("This server runs signed runbooks only").

## Kubernetes and cloud APIs

Many runbooks call `kubectl`, `oc` or a cloud CLI, not commands on the server itself. For those,
the gate runs on a bastion host that holds the credentials, for example a kubeconfig for a
service account. Support engineers can then run the signed runbooks against the cluster
without ever holding its credentials.

## What is signed

The signature covers what runs, and not the parts that change because someone ran the runbook.
That is the same split as [approval](approval.md): code and fence options, but not outputs or
ticked boxes.

The client builds a **manifest** from the Markdown, and that is what gets signed. The manifest
code lives in `@md-runbook/core`, so every client builds it the same way. It is line-based, so
the gate never parses Markdown:

```
md-runbook-manifest 1
name ops/restart-api
version 7
expires 2027-04-30
param TARGET ^[a-z0-9-]{1,32}$
param REPLICAS ^[0-9]{1,2}$
front timeout=300 mode=session
cell 1 bash timeout=60 <base64 of the code>
cell 2 bash lines=any <base64 of the code>
```

- **Covered:** each code cell's code, language and fence options; the front matter that changes
  how cells run (`params:`, `mode:`, `timeout:`, `cwd:`, `shell:`); the name, version and
  expiry date.
- **Not covered:** the prose, outputs, ticked boxes and output markers. Signing the prose would
  break the signature at every tick. The prose cannot make the gate run anything.
- The signature is `ssh-keygen -Y sign -n md-runbook` over the manifest (SSHSIG). It goes at the
  end of the `.md` file as an HTML comment, which stays invisible on screen like the output
  markers:

  ```
  <!-- md-runbook:signature signer=ops@example.net signed=2026-10-22
  -----BEGIN SSH SIGNATURE-----
  …
  -----END SSH SIGNATURE-----
  -->
  ```

- Clients rebuild the manifest from the file. If it no longer matches the signature (a cell was
  edited), they show the runbook as **unsigned**, and a strict server refuses it.

## Parameters, inputs and secrets

Today `${param:NAME}` is pasted into the code. With a value like `x; rm -rf /`, a signed cell
would run unsigned code, so signed runbooks do it differently:

- `md-runbook sign` rewrites `${param:NAME}` to `${MDRB_PARAM_NAME}` in the manifest. The
  signed code is therefore exactly what runs.
- The client sends the values. The gate checks each value against the pattern signed in the
  manifest and sets it as an environment variable. A shell expands a variable's value but never
  runs it as code. A parameter without a pattern cannot be signed.
- `${input:NAME}` works the same way. `${secret:NAME}` also becomes a variable: it has no
  pattern but a length limit, and its value is never logged.
- `${out:NAME}` (a value captured from an earlier cell) is not supported in the first version.
  `sign` refuses runbooks that use it.

## Running cells, lines and steps

- **Whole cell:** always allowed.
- **Step through:** allowed. The gate runs the cell's lines in order, one per request, and
  keeps track of where it is, so no line can be skipped.
- **Single lines or ranges** (`Run line`, `Run lines N-end`, `Check`): only if the signed cell
  has `lines=any`, because skipping a line can skip a safety check.
- One persistent shell per connection, as in the app today
  ([remoteShell.ts](../../packages/ssh/src/remoteShell.ts)). The gate starts it, so cells share
  their folder and variables.

## The gate

- **Language:** one POSIX `sh` file that calls `ssh-keygen` (OpenSSH 8.2 or newer for
  `-Y find-principals`), `base64` and `sha256sum` or `shasum`. Installing it means copying one
  file, with no Node.js on the servers. Linux and macOS first; Windows servers later.
- **Requests** (the SSH command, `SSH_ORIGINAL_COMMAND`): `hello` (version and policy),
  `session` (stdin: the manifest, the signature and parameter values, then `run 2`,
  `step 2`, `lines 2 3-5`), and `stop` (stops this account's own running cell, as the app does
  over a second channel today).
- **Checks, in order:** the manifest's format, the signature (`find-principals`, then `verify`),
  the manifest hash against `revoked`, `expires`, the parameter patterns, then the requested
  cell and lines.
- **Log:** one JSON line per event: time, account, key fingerprint (from
  `ExposeAuthInfo yes`), runbook name, version, manifest hash, signer, cell, lines, exit code,
  duration, and signed or unsigned. Parameter values are logged; secrets never are.
- **Tests:** in CI against the runner's own OpenSSH server, like the app's live SSH test.

## Releasing runbooks to a support team

- **By hand:** `md-runbook sign restart-api.runbook.md --key ~/.ssh/id_ed25519` (it calls
  `ssh-keygen`, and a YubiKey `sk-` key works too). Then share the file.
- **From a repository:** runbooks are reviewed in pull requests. On merge to a protected
  branch, a workflow signs them with a key from the repository's secrets and publishes them.
  The gate trusts only that key (`release-ci@…` above), so the review becomes the release.
- **Withdrawing a release:** add its manifest hash to `revoked` (shown by
  `md-runbook verify`), wait for `expires`, or remove the signer from `allowed_signers`.

## Changes per client

| Where | Change |
| --- | --- |
| `@md-runbook/core` | Builds the manifest. Reads and writes the signature block. Verifies SSHSIG, for the badge. |
| Command line | `md-runbook sign`, and `md-runbook verify`, which prints the signer, the version and the manifest hash. |
| The app | Gate mode in `@md-runbook/ssh`. A "Signed by …" or "Unsigned" badge, and the server's policy shown before running. The relay doesn't change. |
| Extension | **Sign Runbook** and a signed/unsigned status. A lint warning for parameters without a pattern. The extension doesn't run SSH itself, so it needs no gate mode. |

## Limits

- The gate controls what the account can start, not what a signed cell does when it runs. The
  review before signing is the real control. Root access goes through `sudo` rules for the
  gate's account.
- It covers only the keys that are forced to use the gate. Admin accounts with full shells are
  unaffected, by design.
- The prose is not signed. An altered instruction such as "now run X by hand" is not stopped,
  but the gate would still refuse X.

## Open questions

1. **Two signers:** should a server be able to require two signatures (`signers = 2`)?
2. **Verifying in the app:** the app's badge needs SSHSIG verification in TypeScript, for
   ECDSA P-256 and Ed25519. Ed25519 is not in every browser's WebCrypto. Could the badge rely
   on the gate's `hello` instead?
3. **Version floors:** should `gate.conf` also accept "at least version N of runbook X"
   (`min-version ops/restart-api 7`), so older signed versions stop working without listing
   their hashes?
4. **`${out:}`:** should a later version let the gate capture values itself, so runbooks that
   pass output between cells can be signed?

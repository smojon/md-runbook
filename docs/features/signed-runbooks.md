# Signed runbooks

An ops team signs runbooks; a support team runs them from the [md-runbook app](../app.md). A
server set up for this runs **only signed runbooks, unchanged**, for the support team's SSH
keys, and logs every run. Other servers and other keys are not affected: unsigned runbooks run
there as before, and a server's owner can allow them on the gated keys too.

The check is on the server because it has to be: a support engineer's key also works with plain
`ssh server 'anything'`, so a check in the app alone would only prevent accidents. A key may be
restricted to one program, **md-runbook-gate**, and the gate decides what runs.

```
publisher                       support engineer                 server
md-runbook sign  ──.md file───▶ md-runbook app ──SSH──────────▶ sshd: forced command
(signature block in the file)   (any channel: mail, a site, …)   └▶ md-runbook-gate
                                                                    checks signature and policy,
                                                                    runs the signed blocks, logs
```

A signed runbook holds no secrets and any change breaks its signature, so it can be shipped by
any channel. Two keys do different jobs: the **publisher's signing key** says the runbook is
approved and grants no access by itself; the **engineer's SSH key** gets into the server, and
only into a gated account.

## What exists elsewhere

Azure Automation can run only signed runbooks on its hybrid workers (tied to Azure and its
agent). Rundeck, AWX and StackStorm let support teams run predefined jobs, from a central server
that holds the jobs and the credentials. PowerShell's `AllSigned` is a client setting, which
Microsoft says is not a security boundary. Forced-command wrappers are an old SSH technique,
with a fixed list of commands per wrapper. Here the runbook stays a Markdown file, the server
needs one script and a list of signers, and a new release reaches every server without being
deployed to them, because the signature carries the trust.

## Signing

```sh
md-runbook sign restart-api.runbook.md --key ~/.ssh/id_ed25519 \
  --scope web --pattern 'SERVICE=[a-z][a-z0-9-]{0,30}' --expires-in 90
md-runbook verify restart-api.runbook.md --allowed-signers /etc/md-runbook/allowed_signers
```

or **md-runbook: Sign Runbook** in VS Code (it asks for the name, scopes, days of validity and
missing patterns; the key comes from `mdRunbook.signing.key`, or it asks).

- Signing uses `ssh-keygen -Y sign` (OpenSSH 8.2 or newer) with any key it can use: a key file,
  a FIDO `sk-` key, or a `.pub` whose key is in the SSH agent. Keys with a passphrase sign on
  the command line (it asks), or through the agent in VS Code.
- **Signing again** keeps the name, scopes and patterns and counts the version up. Options given
  now win. `--expires` is not carried over.
- `verify` prints what the signature covers, the manifest's sha256, and any block changed since
  signing (with its line). Only with `--allowed-signers` does it check the signature as the gate
  would: without it, the signer's name is just what the file says (anyone can write a name next
  to a signature), and it says so. Exit code 0 when everything is signed.
- Signing refuses what a server would read differently: parameter or `env.*` names such as
  `PATH`, `IFS`, `BASH_ENV`, `LD_*` or `LC_*`; patterns with JavaScript-only syntax (`\d`,
  `(?…)`, lazy `*?`); and, where bash is installed, a block whose commands don't each read as a
  whole command on their own (`bash -n`), since a server may run them one by one.
- The editor and `md-runbook lint` warn about blocks changed since signing.

### From a repository

Runbooks are reviewed in pull requests. On merge to a protected branch, a workflow signs them
with a key from the repository's secrets and publishes them. Servers trust only that key, so the
review becomes the release (the [command line](cli.md#getting-it) on the runner):

```yaml
- run: |
    printf '%s\n' "$SIGNING_KEY" > key && chmod 600 key
    for f in runbooks/*.md; do md-runbook sign "$f" --key key; done
    rm key
  env:
    SIGNING_KEY: ${{ secrets.RUNBOOK_SIGNING_KEY }}
```

## What is signed

The signature covers what the gate runs, not what changes when someone runs the runbook:

| Covered | Not covered |
| --- | --- |
| each `bash`/`sh` block's code, fence options, `cwd=` and `env.*` | prose, outputs, ticked boxes, output markers |
| each block's commands for line runs | other languages' blocks (the gate runs bash) |
| the name, version, expiry date, scopes, parameter patterns | |

The signer signs a **manifest**: one item per line, values in base64, so the gate never parses
Markdown. It travels in the file, in an HTML comment at the end (invisible on screen, like the
output markers), next to the signature:

```
<!-- md-runbook:signature v1 signer=ops@example.net signed=2026-10-22
manifest
bWQtcnVuYm9vay1tYW5pZmVzdCAxCm5hbWUgb3BzL3Jlc3RhcnQtYXBpCnZlcnNpb24gMwpzY29w…
signature
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg…
-->
```

Because the manifest holds the code as signed, a later app version can't change what an old
signature covers. Clients compare the file's blocks with it: a block whose code or options
changed is **unsigned**, and a strict server refuses it. Adding prose keeps blocks signed. A
block that was moved stays signed, but the editor, `md-runbook lint`, `verify` and the app warn
that the order differs from the one reviewed, and they name signed blocks that are missing from
the file (a deleted backup step, say), since the shell carries folders and variables from block
to block.

Signing refuses a bash block inside an HTML comment, and code fences indented 4 spaces or more:
GitHub's rendered view doesn't show those as code that runs, so a reviewer reading a pull
request there could miss them.

**Parameters.** `${param:NAME}` reaches the shell as an environment variable, never as text in
the code. Each needs a pattern (`--pattern NAME=REGEX`, a POSIX extended regular expression the
whole value must match); the gate checks the value and refuses newlines. The front matter isn't
signed, so the app doesn't take a signed block's parameter values from its defaults: they are
typed on the runbook. `${secret:}`, `${input:}` and `${out:}` can't be signed yet.

**Line runs.** A signed block runs whole, or its commands in order (Step through, Run lines 1-N).
Single lines and ranges (Run line, Run lines N-end, checked lines) need `lines=any` on the block
when it is signed, because skipping a line can skip a safety check.

## Setting up a server

The gate is one POSIX `sh` script: [apps/gate](../../apps/gate/README.md) has the install steps.
In short:

```
# ~/.ssh/authorized_keys of the account the support team uses
restrict,command="/usr/local/bin/md-runbook-gate" ecdsa-sha2-nistp256 AAAA… alice@support
restrict,command="/usr/local/bin/md-runbook-gate --unsigned=allow" ssh-ed25519 AAAA… bob@ops
```

```
# /etc/md-runbook/allowed_signers (OpenSSH's own format)
ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA…
release-ci@example.net namespaces="md-runbook",valid-before="20270101" ssh-ed25519 AAAA…
```

```
# /etc/md-runbook/gate.conf
unsigned = refuse          # refuse (default) | allow
scopes   = web staging     # signed runbooks for these scopes run here; * (default) = any
revoked  = /etc/md-runbook/revoked     # manifest hashes, one per line
log      = syslog          # (default) or a file
```

With SSH certificates the CA puts the restriction into each certificate, and servers need no
`authorized_keys` edits: `ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

| Setup | Unsigned blocks | What you get |
| --- | --- | --- |
| No gate | run | Full shell access for the key, as today. |
| Gate, `unsigned = allow` | run | No interactive shell or forwarding; every block is logged with a hash of its code. |
| Gate, `unsigned = refuse` | refused | Only runbooks signed by `allowed_signers`. |
| `--unsigned=allow` / `--unsigned=refuse` on a key's line | per key | Overrides `gate.conf` for that key. |

**Scopes** keep a runbook for staging off production: the manifest names its scopes, `gate.conf`
lists the ones the server accepts, and `--scopes=a,b` on a key's line narrows them. A runbook
runs only if it shares a scope with both; a runbook without scopes runs only where `scopes = *`.

**Withdrawing a release:** add its manifest hash (`md-runbook verify` shows it) to `revoked`,
let it expire, or remove the signer from `allowed_signers`.

**Kubernetes and cloud APIs.** For runbooks that call `kubectl`, `oc` or a cloud CLI, the gate
runs on a bastion host that holds the credentials (a kubeconfig for a service account, say):
support engineers run the signed runbooks against the cluster without ever holding its
credentials.

## Running

The app needs no setting: it finds the gate when it connects (its answer to the app's first
line). A signed runbook shows **Signed runbook NAME, version N** and any blocks changed since
signing. The signer's name is shown as what the file says until a gate has checked the signature;
after the first block that ran through a gate, the banner shows the signer that gate accepted.
Parameter values are typed under **Parameters** on the runbook; the app
checks them against the signed patterns as you type, and the gate checks them again. Through
the gate a signed block runs as "block N of this manifest"; on
a server without the gate the same block runs as usual. A refused block ends with exit 126 and
the gate's reason in its output, for example
`md-runbook-gate: this server runs signed runbooks only (this cell is not signed, or changed since signing)`.

The gate keeps one shell per connection, as the app does elsewhere, so folders and variables
carry over between blocks; loading another runbook unsets the previous one's parameters and
`env.*` values. Cancelling works: the app's stop request on a second channel reaches the gate,
which stops the running block of that connection's shell only. The gate checks parameter
patterns in the C locale, whatever locale the client's SSH session sends.

## The log

One JSON line per event, to syslog (tag `md-runbook-gate`) or a file: `session`, `load`
(runbook, version, manifest hash, signer), `param` (name and value), `run` (block and command),
`end` (exit code), `unsigned` (hash of the code), `refused` (the reason), `stop`. Each carries
the time, the account, the client address and the key: its fingerprint with
`ExposeAuthInfo yes` in `sshd_config`, or the name given with `--who=NAME`.

The `end` events are written by the account's own shell, and a log file must be writable by the
account, so a block (or unsigned text where it is allowed) could add lines of its own. For a log
the account can't touch, use syslog and forward it off the server.

## Limits

- The gate controls what the account can start, not what a signed block does once it runs: the
  review before signing is the real control. Root access goes through `sudo` rules for the
  gate's account.
- Only keys forced to use the gate are covered. Admin accounts with full shells are not, by
  design.
- The prose is not signed: an altered instruction such as "now run X by hand" is not stopped,
  but the gate would still refuse X.
- One signer per runbook; no version floors (revoke by hash instead).
- "In order" means the gate runs a block's commands in their order; it doesn't see their exit
  codes, so a client could go on after a failed command. The app stops at a failure.
- A key with `--unsigned=allow` runs code as the same account as everyone else's keys: keep
  stricter keys on another account (one account per policy).
- The gate runs on Linux and macOS servers (POSIX `sh`, OpenSSH 8.2+, `awk`, `base64`,
  `mkfifo`, `pkill`).

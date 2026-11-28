# Signed runbooks

An ops team signs runbooks; a support team runs them from the [md-runbook app](../app.md). A
server set up for this runs **only signed runbooks, unchanged**, for the support team's SSH keys.
It logs every run.

Other servers and other keys are not affected: unsigned runbooks run there as before. A server's
owner can allow them on the gated keys too.

The check is on the server because it has to be: a support engineer's key also works with plain
`ssh server 'anything'`. So a check in the app alone would only prevent accidents. A key may be
restricted to one program, **md-runbook-gate**, and the gate decides what runs.

```
publisher                       support engineer                 server
md-runbook sign  ──.md file───▶ md-runbook app ──SSH──────────▶ sshd: forced command
(signature block in the file)   (any channel: mail, a site, …)   └▶ md-runbook-gate
                                                                    checks signature and policy,
                                                                    runs the signed blocks, logs
```

A signed runbook holds no secrets and any change breaks its signature, so it can be shipped by
any channel. Two keys do different jobs:

- the **publisher's signing key** says the runbook is approved, and grants no access by itself;
- the **engineer's SSH key** gets into the server, and only into a gated account.

## What exists elsewhere

- **Azure Automation** can run only signed runbooks on its hybrid workers (tied to Azure and its
  agent).
- **Rundeck, AWX and StackStorm** let support teams run predefined jobs, from a central server.
  That server holds the jobs and the credentials.
- **PowerShell's `AllSigned`** is a client setting, which Microsoft says is not a security
  boundary.
- **Forced-command wrappers** are an old SSH technique, with a fixed list of commands per wrapper.

Here the runbook stays a Markdown file, and the server needs one script and a list of signers. A
new release reaches every server without being deployed to them, because the signature carries
the trust.

## Signing

```sh
md-runbook sign restart-api.runbook.md --key ~/.ssh/id_ed25519 \
  --scope web --pattern 'SERVICE=[a-z][a-z0-9-]{0,30}' --expires-in 90
md-runbook verify restart-api.runbook.md --allowed-signers /etc/md-runbook/allowed_signers
```

Or use **md-runbook: Sign Runbook** in VS Code. It asks for the name, scopes, days of validity and
missing patterns. The key comes from `mdRunbook.signing.key`, or it asks.

**From the app.** In a runbook's ⋯ More:

- **Sign Runbook** asks the same in a card at the top, and signs with the app's own key. On a
  phone the private key is in the Secure Enclave or Android Keystore, so it never leaves the
  hardware.
- **Co-sign Runbook** shows the blocks being signed and adds your signature.

The signature is the same OpenSSH format (`ssh-keygen -Y sign`, ECDSA P-256), checked the same
way.

Once, add the app's line to the servers' `allowed_signers`. Under **Hosts & settings → Signing
runbooks**, set your name for signatures and copy the line. It looks like
`you@example.net namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA…`.

The app can't run `bash -n`. So it doesn't check a cell's commands one by one, as VS Code and the
command line do. At run time, a gate refuses a step bash can't read on its own.

Sign in VS Code or on the command line for that check.

- Signing uses `ssh-keygen -Y sign` (OpenSSH 8.2 or newer) with any key it can use. That can be
  a key file, a FIDO `sk-` key, or a `.pub` whose key is in the SSH agent. Keys with a passphrase
  sign on the command line (it asks), or through the agent in VS Code.
- **Signing again** keeps the name, scopes and patterns and counts the version up. Options given
  now win. `--expires` is not carried over.
  - It keeps them only when the old signature verifies. It must be by the key signing now, or
    by a signer in `--allowed-signers FILE` (in VS Code: `mdRunbook.signing.allowedSigners`).
  - Otherwise it says so and keeps nothing: give `--name`, `--scope` and `--pattern` again. The
    version starts at 1 unless you give `--version`.
  - Anyone can edit the manifest in the file. A pull request could loosen a pattern there, and
    a signing workflow would then sign it.
  - The result lists the scopes and patterns signed.
- Signing an unsigned source into a signed copy (`--out signed/deploy.md`) counts on from that
  copy's version. It does so when it is the same runbook (the same signed name), and the result
  line says so: `version 3 (previous: 2 in signed/deploy.md)`.
  - A `--version` that isn't above the copy's is signed as asked, with a note. Servers and team
    libraries that saw the copy's version refuse a lower or equal one.
- `verify` prints what the signature covers, the manifest's sha256, and any block changed since
  signing (with its line). Exit code 0 when everything is signed.
- Only with `--allowed-signers` does `verify` check the signature as the gate would. Without it,
  the signer's name is just what the file says, and `verify` says so. Anyone can write a name
  next to a signature.
- Signing refuses what a server would read differently:
  - parameter or `env.*` names such as `PATH`, `IFS`, `BASH_ENV`, `LD_*` or `LC_*`;
  - patterns with JavaScript-only syntax (`\d`, `(?…)`, lazy `*?`);
  - a block whose commands don't each read alone as a whole command (`bash -n`, where bash is
    installed). This matters since a server may run them one by one.
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

The signature covers the whole runbook as reviewed, and what the gate runs. But it doesn't cover
what changes when someone runs the runbook:

| Covered | Not covered |
| --- | --- |
| each `bash`/`sh` block's code, fence options, `cwd=` and `env.*`, and the placeholders it uses | outputs and output markers, their history |
| each block's commands for line runs | ticked boxes (`- [x]`), notes (Add Note) |
| the name, version, expiry date, scopes, parameter patterns | a run record's signature |
| the whole text (manifest version 2): prose, headings, checklists, front matter, PowerShell and cmd blocks | |

**Manifest version 2.** In signatures made by releases after 0.22.0, the manifest also holds
`text`.

`text` is the SHA-256 of the runbook without what a run adds to it. It lets clients tell **signed
as a whole** from **partly signed**.

Notes and a run record's signature are left aside only outside code blocks. Inside a block, the
same lines are code, and signed.

- They are left aside only as md-runbook writes them, and never inside the front matter.
- Anything else in their place is text that counts, such as HTML after a note's marker.

A line ends at CRLF, LF or a lone CR, as in CommonMark. Every part of md-runbook reads lines the
same way. A runbook with lone CRs that was signed before 0.27 may need signing again.

- **Signed with 0.22.0 or earlier.** Only the bash/sh blocks and calls are signed.
  - The signature still verifies and the bash blocks still count as signed. But the editor and
    lint say "partly signed", and the app "these steps verified".
  - The app says **Partly signed** instead when PowerShell or cmd blocks are outside the
    signature.
  - A PowerShell or cmd block in such a runbook is never signed.
  - A change to a paragraph goes unnoticed.
  - Links and `md-runbook run --allowed-signers` count it as signed only while its front matter
    holds labels alone. These are `title`, `description`, `tags`, `author`, `owner`, `incident`,
    `severity`, `evidence`, `drill`, `rto` and `prose`, and `params` without defaults or choices.
    Any other key, today's or a future one, makes it unsigned.
  - Sign it again to cover the whole runbook.
- **Text changed since signing.** A changed sentence, a new `- [ ]` item, a changed
  `manual-steps:`, an added PowerShell block: the runbook is "changed since signing".
  - Its unchanged bash blocks still run through a gate.
  - Clients no longer show the runbook as signed as a whole.
  - The runbook's [run report settings](run-reports.md#required-and-signed-reports) lapse until
    it is signed again.
- **Gates.** The header line stays `md-runbook-manifest 1`, and the gate ignores `text`: it
  reads items by key and never sees the text. Gates already installed run version 2 signatures
  unchanged, and new gates still run version 1 ones.
- **Co-signing** a version 1 manifest keeps it version 1, since co-signing never changes what
  was signed.

**Signer names** in the block (`signer=`, `cosign signer=`) must be names allowed_signers can
hold as a principal. That means ASCII letters, digits and `@ . _ + -`, with no patterns or lists.
A block with another name is not read as a signature.

**Run summaries are signed in another namespace.** A [run report](run-reports.md) is signed with
the runner's key as `ssh-keygen -Y sign -n md-runbook-run`. A runbook signature never verifies
as a run summary, nor the reverse, even with a key allowed for both.

Keep runners' keys out of the servers' `allowed_signers`, or limit them to
`namespaces="md-runbook-run"`.

The signer signs a **manifest**: one item per line, values in base64, so the gate never parses
Markdown. It travels in the file, in an HTML comment at the end, next to the signature. The
comment is invisible on screen, like the output markers:

```
<!-- md-runbook:signature v1 signer=ops@example.net signed=2026-10-22
manifest
bWQtcnVuYm9vay1tYW5pZmVzdCAxCm5hbWUgb3BzL3Jlc3RhcnQtYXBpCnZlcnNpb24gMwpzY29w…
signature
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg…
-->
```

Because the manifest holds the code as signed, a later app version can't change what an old
signature covers. Clients compare the file's blocks with it:

- A block whose code or options changed is **unsigned**, and a strict server refuses it.
- Adding prose keeps blocks signed.
- A block that was moved stays signed.

But the shell carries folders and variables from block to block. So the editor,
`md-runbook lint`, `verify` and the app:

- warn that the order differs from the one reviewed;
- name signed blocks that are missing from the file (a deleted backup step, say).

GitHub's rendered view doesn't show some blocks as code that runs, so a reviewer reading a pull
request there could miss them. Signing refuses them:

- a code block inside the front matter (GitHub shows the front matter as a table);
- a bash block inside an HTML comment;
- a bash block inside another HTML block, such as `<script>`, `<pre>`, or a `<div>` with no
  blank line after it;
- a bash block right after a tag alone on its line, such as `<span>`, unless a paragraph comes
  before the tag;
- code fences indented 4 spaces or more;
- bidi controls and invisible characters in a block, a call or a fence line, such as U+202E
  or U+200B. Write them as escapes (`$'\u202e'`).

Lint also warns about a code block in the front matter, and about hidden characters.

**Parameters.** `${param:NAME}` reaches the shell as an environment variable, never as text in
the code.

- Each parameter needs a pattern (`--pattern NAME=REGEX`): a POSIX extended regular expression
  the whole value must match.
- The gate checks the value and refuses newlines.
- The gate never sees the front matter (and a version 1 signature doesn't cover it). So the app
  doesn't take a signed block's parameter values from its defaults: they are typed on the
  runbook.

**Inputs and captured values.** `${input:NAME}` (asked when the cell runs) and `${out:NAME}` (a
value an earlier block captured with `capture=`) are signed like parameters:

- each needs a pattern under the same name (`--pattern SINCE='[0-9]+[smh]'`);
- the client sends the value to the gate with the run;
- the gate checks it against the signed pattern.

That way a later block can use what an earlier one printed (a pod name, a ticket). The value is
not part of the code.

Secrets can't be signed: `${secret:}`, `${input:NAME:secret}` and values from `capture-secret=`,
because the gate logs every value it is given.

**Line runs.** A signed block runs whole, or its commands in order (Step through, Run lines 1-N).

Single lines and ranges (Run line, Run lines N-end, checked lines) need `lines=any` on the block
when it is signed. This is because skipping a line can skip a safety check.

## Runbook calls

A [runbook call](calls.md) is signed as written: its options (`src=`, `section=`, …) and the
values it passes.

- Every `${param:}`, `${input:}` and `${out:}` in the call needs a pattern
  (`--pattern TO='[0-9]{5}\.[0-9]{4}'`).
- A secret can't be passed.
- `src=` must be relative.

The runbook it calls is not part of this signature. It is signed on its own, with its own
patterns, and checked with the values passed.

The gate never runs a call itself. The md-runbook app runs the steps of the runbook called, each
checked against that runbook's own signature. It tells the gate which call loaded it, for the log
(see [The log](#the-log)).

On a machine, `md-runbook run --allowed-signers FILE` runs a signed runbook only as signed, as
the gate would. Before anything runs, it refuses (exit `2`) when:

- the signature is not good by a key in `FILE`, or has expired;
- a block or a call changed, moved or was removed since signing;
- a block that would run is not signed (only bash/sh blocks are);
- a parameter, or an input given with `--input` or the environment, doesn't match its signed
  pattern;
- a call's runbook is outside the repository (the folder with `.git`), doesn't exist, or is not
  signed;
- a call's runbook fails these same checks with the values the call passes.

A captured value (`${out:NAME}`) is checked when the step that uses it would run. When it doesn't
match its signed pattern, that step doesn't run and the run fails. A value with no signed pattern
is refused too, as the gate refuses it.

A call whose `src=` uses `${out:}` or `${input:}` is checked when it runs.
`md-runbook verify --allowed-signers FILE` checks a runbook's calls with fixed `src=` too, and
lists the others.

## Setting up a server

The gate is one static binary:
- for Linux and macOS, on amd64 and arm64;
- on each [release](https://github.com/smojon/md-runbook/releases), with a `SHA256SUMS` file;
- installed as [apps/gate](../../apps/gate/README.md) says. In short:

```sh
v=0.36.0                           # the release you install
f=md-runbook-gate-linux-amd64      # or -linux-arm64, -darwin-amd64, -darwin-arm64
base=https://github.com/smojon/md-runbook/releases/download/v$v
curl -fsSL -O "$base/$f" -O "$base/SHA256SUMS"
grep " $f\$" SHA256SUMS | sha256sum -c -     # macOS: shasum -a 256 -c -
sudo install -m 755 "$f" /usr/local/bin/md-runbook-gate
```

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
floors   = /etc/md-runbook/floors      # NAME LOWEST-VERSION, one per line
signers  = 1               # distinct trusted signers a runbook needs: 1 (default) to 5
log      = syslog          # (default) or a file
report_to = https://runbooks.example.net/v1/runs   # optional: run reports (below)
report_token_file = /etc/md-runbook/report-token   # its bearer token
```

The ops host keeps that token in a Secret, not next to `gate.conf` ([Run reports from the gate](#run-reports-from-the-gate)).

With SSH certificates the CA puts the restriction into each certificate, and servers need no
`authorized_keys` edits: `ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

| Setup | Unsigned blocks | What you get |
| --- | --- | --- |
| No gate | run | Full shell access for the key, as today. |
| Gate, `unsigned = allow` | run | No interactive shell or forwarding; every block is logged with a hash of its code. |
| Gate, `unsigned = refuse` | refused | Only runbooks signed by `allowed_signers`. |
| `--unsigned=allow` / `--unsigned=refuse` on a key's line | per key | Overrides `gate.conf` for that key. |

**Scopes** keep a runbook for staging off production:

- the manifest names its scopes;
- `gate.conf` lists the ones the server accepts;
- `--scopes=a,b` on a key's line narrows them.

A runbook runs only if it shares a scope with both; a runbook without scopes runs only where
`scopes = *`.

**Withdrawing a release:** add its manifest hash (`md-runbook verify` shows it) to `revoked`,
let it expire, or remove the signer from `allowed_signers`. To withdraw all older releases of a
runbook at once, give it a **version floor**. The `floors` file has lines like
`ops/restart-api 7`, and the gate then refuses versions 1 to 6 of `ops/restart-api`.

**Two signers (four eyes).** With `signers = 2` in `gate.conf` (or `--signers=2` on a key's
line), a runbook needs two signatures. They must come from two distinct signers in
`allowed_signers`, say its author and a reviewer.

1. The author signs (`md-runbook sign`, Sign Runbook).
2. The reviewer then adds a signature to the same manifest, with:
   - `md-runbook sign FILE --key KEY --cosign`;
   - or **Co-sign Runbook** (Share ▾ in VS Code, ⋯ More in the app: a reviewer can co-sign from
     a phone).

Co-signing changes nothing that was signed and is refused if the blocks changed since. Two
signatures of one key count once. A signature from a key the server doesn't trust doesn't count
at all.

`md-runbook verify --allowed-signers FILE` checks every signature; the gate logs all signers,
and the app shows them.

**Kubernetes and cloud APIs.** For runbooks that call `kubectl`, `oc` or a cloud CLI, the gate
runs on a bastion host. That host holds the credentials (a kubeconfig for a service account,
say).

Support engineers run the signed runbooks against the cluster without ever holding its
credentials.

**A team library** of signed runbooks: `md-runbook publish FILE --library URL`, or **Publish to
Library…** in VS Code (Share ▾). The
[library server](../../apps/library-server/README.md) publishes a runbook into the folder the web
app serves only when it is:

- signed as a whole by the library's `allowed_signers`;
- unchanged and unexpired;
- named as its file;
- of a higher version than the one published.

## Running

The app needs no setting: it finds the gate when it connects (its answer to the app's first
line). A signed runbook shows **Signed runbook NAME, version N** and any blocks changed since
signing.

The signer's name is shown as what the file says until a gate has checked the signature. After
the first block that ran through a gate, the banner shows the signer that gate accepted.

Parameter values are typed under **Parameters** on the runbook. The app checks them against the
signed patterns as you type, and the gate checks them again.

Through the gate a signed block runs as "block N of this manifest". On a server without the gate
the same block runs as usual. A refused block ends with exit 126 and the gate's reason in its
output, for example
`md-runbook-gate: this server runs signed runbooks only (this cell is not signed, or changed since signing)`.

The gate keeps one shell per connection, as the app does elsewhere, so folders and variables
carry over between blocks. Loading another runbook unsets the previous one's parameters and
`env.*` values.

Cancelling works: the app's stop request on a second channel reaches the gate. It stops the
running block of that connection's shell only. The gate checks parameter patterns in the C
locale, whatever locale the client's SSH session sends.

## The log

One JSON line per event goes to syslog (tag `md-runbook-gate`) or a file. The events:

- `session`;
- `load`: runbook, version, manifest hash, signer.
  - For the runbook a [call](calls.md) runs, also `called-by`, the caller's manifest hash, and
    `call`, the call's number.
  - For a run an alert link started, also `alert`, `alert-fingerprint` and `alert-starts-at`.
- `param`: name and value;
- `run`: block and command;
- `end`: exit code;
- `unsigned`: hash of the code;
- `refused`: the reason;
- `stop`;
- `report`: a run report sent or not (below).

Each event carries the time, the account, the client address and the key (`who`). With
`ExposeAuthInfo yes` in `sshd_config`, `who` is:
- the key's fingerprint;
- or, for an [SSH certificate](ssh-certificates.md), its key ID, such as `alice@example.com`.
  Each event then also names the CA (`cert_ca`).

`--who=NAME` on the key line wins over both.

The `end` events are written by the account's own shell, and a log file must be writable by the
account. So a block (or unsigned text where it is allowed) could add lines of its own. For a log
the account can't touch, use syslog and forward it off the server.

`md-runbook audit` turns these logs into a report, and matches saved run records against them
([command line](cli.md#gate-audit), [for auditors](for-auditors.md)). A run of a runbook a call
ran says so: `ops/release v9 · called by ops/upgrade v4 (call 1)`.

That link is what the app said when it loaded the runbook called (the `called` request, gate
protocol 2). It lets you follow a call in the log. It grants nothing, since each runbook's own
signature is what the gate checks.

A run started from an [alert link](run-reports.md#which-alert-a-run-answered) says which alert
it answered:
`ops/restart-api v7 · for alert ApiDown (fingerprint 5f3c9e, started 2026-11-14T08:58:00Z)`. The
app sends the link's `ALERT`, `ALERT_FINGERPRINT` and `ALERT_STARTS_AT` values with each load
(the `note` request, gate protocol 3). It sends them whether or not a block uses them.

Like `called`, the note is only what the app says, for the audit: it grants nothing and runs
nothing. The gate checks the values strictly and refuses a note that doesn't match:

- a name of at most 400 bytes on one line;
- a fingerprint of letters, digits and `. _ : -`;
- an RFC 3339 time.

Gates older than protocol 3 are sent no note and log no alert; update the gate to have it.

## Run reports from the gate

A client can be changed not to [report its runs](run-reports.md); the gate can't be skipped on a
gated server. With `report_to` in `gate.conf`, the gate sends a run summary itself when a session
ends. It sends one per signed runbook the session ran, whatever client ran it.

```
# /etc/md-runbook/gate.conf
report_to = https://runbooks.example.net/v1/runs
report_token_file = /etc/md-runbook/report-token   # a file with the bearer token
```

On the [ops host](../../apps/ops/README.md#in-a-cluster), `/etc/md-runbook` is a ConfigMap. Put
the token in the Secret `md-runbook-ops-report-token` instead:
`report_token_file = /etc/md-runbook-ops/report/token`.

The summary has the [run report format](run-reports.md#the-format-version-1) with client
`gate`:

- `runbook.signed`: the signed name, version, manifest hash and the signers the gate accepted
  (`trusted: true`). There is no `file` or `sha256`: the gate never sees the runbook's text,
  only its signed manifest.
- `who`: with `ExposeAuthInfo yes`, the key's fingerprint or an
  [SSH certificate](ssh-certificates.md)'s key ID; or `--who=NAME`; else the account.
- `gate`: the server's name (`uname -n`), the account, and the SSH client's address (`from`).
  `gate_mode` says how the blocks ran: `shared` or `separated`
  ([a gate in separated mode](run-reports.md#a-gate-in-separated-mode)). Without it, the
  summary counts as `shared`.
- `steps`: the signed bash blocks, in order. Each is labelled by the first line of its code (as
  the gate runs it, with placeholders rewritten as signed). Its state is one of:
  - `passed`: ran whole, or its last command ran, exit 0;
  - `failed`: a non-zero exit;
  - `not-run`.
- `ran` lists the blocks the session ran.
- `stopped: true` when one of them never ended (the session was cut, or a block ran `exit`).

Never an output or a parameter value.

The gate sends it with `curl`, in the background once the session is over. So it never holds up
or fails a run.

The gate tries 3 times (not again after a `4xx` other than 408 and 429). It logs a `report` event
with `sent` or `failed` and the HTTP status.

The token is read from its file at the end of the session. It is passed to curl in a header file,
never on its command line.

To an address that isn't https (http only for localhost), nothing is sent. The gate logs it as
`report` `off` at the start of each session.

The [library server](../../apps/library-server/README.md) keeps a gate's summary as verified
(`trust: gate`) when it comes with one of its `RUNS_GATE_TOKENS`, or
`RUNS_SEPARATED_GATE_TOKENS` for a gate in separated mode. It refuses `client: "gate"` from
anyone else.

The token file must be readable by the gate's account. So a block, or someone who can run
commands as that account, could send a summary with it too. Give each server its own token.

The gate's log stays the record to audit; the summaries are the team's view of it.

The address comes from `gate.conf` only: a signed runbook's own `report-runs:` is not read here.
The gate gets the manifest, which signs a hash of the runbook's text but not the text itself. So
it can't see the front matter.

## In a hosted library

A team library ([the app](../app.md#team-runbooks), [hosting it](../../apps/web/README.md#a-team-library))
shows each runbook's signature in the list, with the signed name and version. The opened copy's
banner says the same.

The app checks the signatures itself, against its one list of
[trusted signers](../app.md#trusted-signers). That list holds:

- the keys the user trusted from that library;
- the keys the user added, which count for every runbook.

The same list decides run reports' required and signed settings. Every check of the app (the
list, the banner, signedOnly, run reports) reads one answer for what the signature covers:

- **Signed by alice@example.net: whole runbook verified:** both of these hold.
  - Manifest version 2, and the text as signed: prose, front matter, checklists, PowerShell and
    cmd blocks. Outputs, notes and ticked boxes are left aside.
  - The signature checks out with a key that counts for this runbook, for the name in the
    signature block. OpenSSH's rules apply: principals and patterns, `namespaces=`,
    `valid-after` / `valid-before`.

  When a key may sign under any name its pattern matches (`*`, `*@example.net`), the label adds
  the key's fingerprint.
- **Signed by alice@example.net: these steps verified:** the same check of a manifest version 1
  signature:
  - the bash blocks and runbook calls are unchanged since signing;
  - every block the app could run is among them.

  That is all it proves. The prose, checklists, title, front matter and outputs are not in a
  version 1 manifest (see [What is signed](#what-is-signed)). The banner says so.
- **Partly signed:** a version 1 signature whose blocks check out. But the runbook has blocks
  that can run outside it (PowerShell, cmd: version 1 never signs them). Not verified.
  - With version 2 such a block is part of the text. Adding one makes the runbook **changed
    since signing**, never partly signed.
- **Signed by alice@example.net, expired on 2026-12-31:** checked, but past the manifest's
  `expires` day (UTC, as the gate). Not verified.
- **Signed, unknown signer:** unchanged, but signed by no one the user trusts for this library
  (or not checkable on this device).
- **Signature does not check out for alice@example.net:** one of these.
  - A trusted name but another key.
  - A signature that doesn't verify.
  - A signature that is not one (malformed, truncated, for another namespace).
  - A signer name an `allowed_signers` principal couldn't spell the same way.
- **Changed since signing** (a block changed, or with version 2 any of the text) and **Not
  signed**, as everywhere else.

Next to it the row shows the signed **name and version**, and flags:

- a name that is not the end of the file's path (`db/drop-staging` served as `restart-web.md`,
  `staging/restart` as `prod/restart.md`);
- a **version older** than one of this file this library showed before with a signature that
  checked out.

The app remembers the highest version per library, path and signed name. It works like the
gate's version floors on a server. **Hosts & settings → Team library → Forget the versions
seen** clears them.

The library may publish its `allowed_signers` (the gate's file). The app offers it under **Trust
these signers**, with:

- the names;
- what a pattern lets a key sign as;
- the key fingerprints.

It asks first: the list comes from the server that serves the runbooks, so the server is vouching
for itself.

Trusted keys count for that library only, with the options the library publishes their lines
with now. A `valid-before=` added to retire a key is followed.

A key the library stops publishing stops counting, and is remembered so while the file can't be
read. Published again, it counts only once you trust it again: **Trust these signers** shows the
day it was withdrawn. **Hosts & settings → Trusted signers** lists them all with where each
counts, and **Remove**.

Lines with an option OpenSSH doesn't know are skipped, as OpenSSH skips them. So are lines OpenSSH
could read otherwise than the app:

- a backslash (OpenSSH reads `\"` as an escape);
- a quote anywhere but around an option's value, or a value without quotes;
- an option given twice;
- a control character or a blank other than space and tab.

VS Code refuses the same lines, and writes each line it adds rebuilt from what it read. Its
checks, and `--allowed-signers` on the command line, use only the lines md-runbook reads. The
command line names each line it leaves out.

An index.json with `"signedOnly": true` makes the app open **verified** runbooks only.

- Unsigned, changed, partly signed, expired, unknown-signer, other-name and older-version
  runbooks are listed as not openable, with the reason.
- A copy the user already has is checked again when opened from the list. It is checked again
  before any of its blocks runs too, wherever it was opened from. When the library isn't read,
  the app checks by the policy it remembers.
- A refused copy is offered **Replace with the library's version**.
- Once a library asked for it, the app keeps it on when index.json stops asking, until the user
  agrees.
- An update's signature is checked again for the update, never taken from an earlier read.
  Before an update replaces the user's copy, it says so when its new version:
  - drops the signature, or comes from another signer or key;
  - changed since signing;
  - is partly signed, expired or older.

The app checks these signatures:

- `ssh-ed25519`;
- ECDSA (`nistp256`, `nistp384`, `nistp521`);
- RSA (`rsa-sha2-256`, `rsa-sha2-512`);
- security-key and passkey signatures (`sk-ssh-ed25519`, `sk-ecdsa-sha2-nistp256`,
  `webauthn-sk-ecdsa-sha2-nistp256`, what the app's passkey makes).

It applies OpenSSH's checks:

- no bytes after the signature's fields;
- RSA keys of 2048 bits or more;
- for passkeys, no attested data;
- an extensions field present exactly when flagged;
- no quote in the origin.

Certificate authorities (`cert-authority` lines) are not used. Key validity (`valid-after` /
`valid-before`) and expiry are judged by the device's clock.

This check tells the user what they are opening; the gate on the server is still what decides
what runs.

### In VS Code

The **Library** view (Runbook activity bar) shows the library at `mdRunbook.library.url`, by
folder. Each row says what its signature is worth:

- checked with `ssh-keygen -Y verify` against `mdRunbook.signing.allowedSigners`, then against
  the keys you trusted from this library;
- verified only when signed as a whole, unchanged, not expired, under a name that fits its path;
- a version older than one seen before is flagged, as in the app.

Opening a row makes your own copy, as a link does. A `signedOnly` library opens verified
runbooks only.

**Trusted Signers…** (Share ▾, the view's ⋯) lists the signers you trust in two groups:

- **Yours**, in `mdRunbook.signing.allowedSigners`: they count for every runbook.
  - Add an allowed_signers line or a public key, pasted or from a file.
  - With no file set, adding one offers to make it.
- **Each library's**, under its address: they count for that library's runbooks only.
  - **Add the Team Library's Signers…** adds them, after their fingerprints and a warning.
  - VS Code keeps them in its storage, one file per library address, as the app keys them.

As in the app:

- Choosing a signer removes it from the file it is in, after a confirm.
- A key the library no longer publishes is **withdrawn**: it stops counting, and is shown so.
  - Published again, it counts only once you trust it again. **Add the Team Library's
    Signers…** shows when it was withdrawn.
- A library's keys count for your copies of its runbooks too: run reports
  (`report-runs-required`, `report-runs-signed`) and Practice on a Host.
  - Links, the command line and the gate use only the file you name.
- Keys an earlier version added to your own file from a library stay there, counting for every
  runbook. They are marked **also published by** that host: remove them to trust them for the
  library's runbooks only.

Lines it adds get `namespaces="md-runbook"`. **Publish to Library…** and **Remove from
Library…** (Share ▾) talk to the library server.

## Limits

- The gate controls what the account can start, not what a signed block does once it runs. The
  review before signing is the real control. Root access goes through `sudo` rules for the
  gate's account.
- Only keys forced to use the gate are covered. Admin accounts with full shells are not, by
  design.
- The gate doesn't check the prose: it sees the manifest, not the text. An altered instruction
  such as "now run X by hand" isn't stopped there, but the gate still refuses that command.
  With a version 2 signature, VS Code, the app and `md-runbook verify` show the change.
- "In order" means the gate runs a block's commands in their order. It doesn't see their exit
  codes, so a client could go on after a failed command. The app stops at a failure.
- A key with `--unsigned=allow` runs code as the same account as everyone else's keys. Keep
  stricter keys on another account (one account per policy).
- The gate runs on Linux and macOS servers (POSIX `sh`, OpenSSH 8.2+, `awk`, `base64`,
  `mkfifo`, `pkill`).

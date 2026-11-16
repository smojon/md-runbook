# md-runbook-gate

The forced command of SSH keys that may only run **signed runbooks**: one POSIX `sh` script. It
checks each runbook against:
- `allowed_signers`, for its signature;
- the server's policy (unsigned blocks, scopes, revoked releases, expiry);
- the parameters' patterns.

Then it runs the signed blocks in one shell per connection, and logs every request. What it is
for, and how runbooks are signed:
[docs/features/signed-runbooks.md](../../docs/features/signed-runbooks.md).

## Needs

- Linux or macOS with OpenSSH 8.2 or newer (`ssh-keygen -Y`).
- The usual tools: `awk`, `base64`, `env`, `mkfifo`, `mktemp`, `od`, `pgrep` (to cancel),
  `logger` (for syslog), `sha256sum` or `shasum`.
- bash if the runbooks need it (else the blocks run in `sh`).
- `curl` for run reports (`report_to`).

## Install

```sh
sudo install -m 755 md-runbook-gate /usr/local/bin/md-runbook-gate
sudo install -d -m 755 /etc/md-runbook
sudo install -m 644 gate.conf.example /etc/md-runbook/gate.conf
# The publishers' public keys, in OpenSSH's allowed_signers format:
echo 'ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA…' | sudo tee /etc/md-runbook/allowed_signers
```

Then restrict each support key in the account's `authorized_keys`:

```
restrict,command="/usr/local/bin/md-runbook-gate" ecdsa-sha2-nistp256 AAAA… alice@support
restrict,verify-required,command="/usr/local/bin/md-runbook-gate" sk-ecdsa-sha2-nistp256@openssh.com AAAA… bob@web
```

The second is the web app's passkey (**Use a passkey**). `verify-required` makes sshd refuse a
signature made without the person's fingerprint, face or PIN. The gate logs its fingerprint as
for any key.

`restrict` turns off port, agent and X11 forwarding and the pty. Options on the command:
- `--unsigned=allow|refuse`, `--scopes=a,b` and `--signers=N` override `gate.conf` for that key;
- `--who=NAME` is the name logged for it;
- `--config=FILE` reads another config.

With SSH certificates, put the restriction into the certificate instead:
`ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

**Keep the gate's files out of the account's reach.** Signed blocks run as the account, so it
must not own the script, `/etc/md-runbook/` or (ideally) its own `authorized_keys`. For
example: `AuthorizedKeysFile /etc/ssh/authorized_keys/%u` with root-owned files.

Add `ExposeAuthInfo yes` to `sshd_config` to log each key's fingerprint.

## All signed or none

At the start of each session, the gate reads the account's keys. `authorized_keys =` names the
files, as `AuthorizedKeysFile` does (default `~/.ssh/authorized_keys` and `authorized_keys2`).
It accepts the account only as one of two kinds:
- **Signed:** every key runs this gate, none with `--unsigned=allow`, and `unsigned = refuse`.
  Run reports go out as the gate's.
- **Unsigned trial:** every key allows unsigned blocks. Blocks run, but `report_to` sends
  nothing, so no report from this account counts as sent by a gate.

Anything else stops the session before it starts, naming the lines to change:
- a key without `command="…/md-runbook-gate …"`, or with more after the gate's options;
- a mix of signed and unsigned keys: give the unsigned ones their own account;
- a file it can't read.

The check reads key lines with their options (`restrict`, `from=`, `environment=`, quoted
values) and `cert-authority` lines too.

What it can't see, so keep this account for the gate alone and without a password:
- keys from `AuthorizedKeysCommand`, and the principals of SSH certificates;
- password or keyboard-interactive logins;
- other programs running as the same account.

With `ForceCommand` in `sshd_config` (as on the [ops host](../ops/README.md)), set
`sshd_force_command = yes`. Then every login runs the gate whatever the key lines say, and
`unsigned` in `gate.conf` decides the kind alone.

## The blocks' shell

- **A fresh shell for each runbook:** `bash --noprofile --norc`, else `sh`. Functions, aliases,
  traps, options and variables of another runbook don't carry over.
- **The blocks of one runbook share it,** as in a plain session: `cd`, variables and `set -e`
  carry over. Loading the same runbook again keeps it.
- **No profile:** not `/etc/profile`, `~/.profile` or `~/.bashrc`. The account can write those,
  so they would run in every signed block.
- **PATH** is `path =` in `gate.conf` (default `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`).
  Add the folders of tools such as `kubectl` there, root-owned folders only.
- **Locale:** `locale =` in `gate.conf` (default `auto`: `C.UTF-8` where the system has it, else
  `C`). The client's `LANG` and `LC_*` never reach a block.
- **Environment:** what sshd set for the gate, minus what changes how a shell or the loader
  starts (`BASH_ENV`, `LD_*`).
- **kube-context:** a block signed with `kube-context=NAME` (or `kube-context=${param:NAME}`)
  runs only while `kubectl config current-context` says that context. The gate checks it
  itself, after the block's `env.*`, and refuses otherwise (exit 126). The front matter's
  `kube-context:` isn't signed: only the app checks that one.
- **The work folder:** the gate keeps the verified manifest and the parameters in memory. It
  writes each block to a new file and checks its hash again just before the shell runs it.
  - A block can still find that folder: it runs as the account.

## Trust

Signed blocks run as the account. So a gate is only as strong as the account around it:
- **Use `unsigned = refuse` for every key of the account**, or the gate's checks prove nothing.
  An unsigned block can change anything the account can.
- **Use `log = syslog`.** A block can edit a log file the account can write.
- **Reports that say "sent by a gate" need both.** A block can read `report_token_file` and send
  reports of its own.
- **After any time with `unsigned = allow`**, change the report token. Remove what the account
  may have planted in its home folder and crontab.

## Check it

From a machine with the support key:

```sh
printf ': mdrb-gate-hello 0123abcd; x\n' | ssh -i support_key support@server
```

prints `__MDRB_GATE__ 3 unsigned=refuse` (after a control character) and the session's number.
The log (`journalctl -t md-runbook-gate`, or the `log =` file) shows a `session` event.

Then open a signed runbook in the md-runbook app and run a block. On the server itself,
`md-runbook verify --allowed-signers /etc/md-runbook/allowed_signers file.md` checks a
runbook's signature.

## Protocol

The app's first line is `: mdrb-gate-hello ID; …`, which a plain shell runs as it is, so the
app needs no setting. The gate answers with its banner. Then come the requests, one per line,
base64 for anything that could hold spaces.

Replies end with the marker a plain session uses (`\036__MDRB_<id>__ <exit>` on stdout and
stderr). Refusals exit 126 with the reason on stderr.

The banner's number is the protocol (3). The app sends a request only to gates whose protocol
has it:

| Request | |
| --- | --- |
| `called ID SHA256 N` | (Protocol 2) The next load is the runbook that call N of the runbook with this manifest hash runs: logged with that load. Grants nothing. |
| `note ID KEY VALUE …` | (Protocol 3) The next load answers this alert (an alert link's values, base64): `ALERT` (required, at most 400 bytes), `ALERT_FINGERPRINT` (letters, digits and `. _ : -`, at most 128), `ALERT_STARTS_AT` (an RFC 3339 time); none with a control character, each key once. Logged with that load as `alert`, `alert-fingerprint`, `alert-starts-at`; a note that doesn't match is refused whole. Grants nothing, runs nothing. |
| `load ID MANIFEST SIGNATURE` | Check and keep a signed manifest; answers `\036__MDRB_SIGNED__ PRINCIPAL SHA256`. |
| `param ID NAME VALUE` | A parameter's value, checked against the manifest's pattern. |
| `run ID N`, `step ID N K` | Run signed block N, or its command K (0-based). |
| `raw ID TEXT` | Shell text, only where unsigned blocks are allowed. |
| `context ID` | Runs `kubectl config current-context`, for runbooks with `kube-context:` ([Kubernetes](../../docs/features/kubernetes.md)). Answered on every server, because it only reads the kubeconfig. The gate checks a signed block's `kube-context=` itself all the same. |

The cells' shell has two variables, so tools on the server can log against them:
- `MD_RUNBOOK_GATE_WHO`: the key, as logged;
- `MD_RUNBOOK_GATE_RUN`, during a signed run: its request id.

md-runbook-probe on the [ops host](../ops/README.md) logs against them. Neither can be set by a
manifest.

To cancel, the app sends the command `pkill -TERM|-KILL -P N 2>/dev/null; true` on a second
connection:
- `N` is the number the session's hello answered: a random one, which only that client knows.
- The gate sends the signal to every program under that session's shell, not only its children.
- The shell itself goes on.

## Run reports

With `report_to = https://…/v1/runs` in `gate.conf`, the gate sends a
[run summary](../../docs/features/run-reports.md) of each signed runbook a session ran. It sends
them when the session ends. `report_token_file` is a file with the bearer token.

Each summary holds:
- client `gate`;
- the signed name, version, manifest hash and signers;
- the key (`who`), the server, account and client address;
- each signed block's label (the first line of its code) and state.

It never holds an output or a parameter value.

It needs `curl`, and runs in the background after the session. It tries 3 times, and logs a
`report` event (`sent` or `failed`, with the HTTP status). It never holds up or fails a run.

- curl reads no `~/.curlrc` (`-q`): a block could have written one.
- An unsigned-trial account sends none ([All signed or none](#all-signed-or-none)).
- A report says "sent by a gate" truthfully only under the conditions of [Trust](#trust).

The [library server](../library-server/README.md) keeps it as verified when the token is one of
its `RUNS_GATE_TOKENS`. More in
[signed runbooks](../../docs/features/signed-runbooks.md#run-reports-from-the-gate).

## Tests

- `test/gate.test.ts` drives the script as sshd starts it: the protocol on stdin, signatures
  from the real `ssh-keygen`.
- `test/ssh.live.test.ts` runs the app's SSH layer through it on CI's OpenSSH server, cancelling
  and reconnecting included.

Locally on Windows:
`MD_RUNBOOK_GATE_SH="C:\Program Files\Git\usr\bin\dash.exe" node --test out/test/gate.test.js`.

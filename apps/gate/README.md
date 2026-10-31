# md-runbook-gate

The forced command of SSH keys that may only run **signed runbooks**: one POSIX `sh` script. It
checks each runbook's signature against `allowed_signers`, the server's policy (unsigned
blocks, scopes, revoked releases, expiry) and the parameters' patterns, then runs the signed
blocks in one shell per connection, and logs every request. What it is for, and how runbooks
are signed: [docs/features/signed-runbooks.md](../../docs/features/signed-runbooks.md).

## Needs

Linux or macOS with OpenSSH 8.2 or newer (`ssh-keygen -Y`), and the usual tools: `awk`,
`base64`, `mkfifo`, `pkill`, `logger` (for syslog), `sha256sum` or `shasum`. bash if the
runbooks need it (else the blocks run in `sh`).

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

The second is the web app's passkey (**Use a passkey**): `verify-required` makes sshd refuse a
signature made without the person's fingerprint, face or PIN. The gate logs its fingerprint as
for any key.

`restrict` turns off port, agent and X11 forwarding and the pty. Options on the command:
`--unsigned=allow|refuse`, `--scopes=a,b` and `--signers=N` override `gate.conf` for that key, `--who=NAME` is
the name logged for it, `--config=FILE` reads another config.

With SSH certificates, put the restriction into the certificate instead:
`ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

**Keep the gate's files out of the account's reach.** Signed blocks run as the account, so it
must not own the script, `/etc/md-runbook/` or (ideally) its own `authorized_keys`; for
example `AuthorizedKeysFile /etc/ssh/authorized_keys/%u` with root-owned files. Add
`ExposeAuthInfo yes` to `sshd_config` to log each key's fingerprint.

## Check it

From a machine with the support key:

```sh
printf ': mdrb-gate-hello 0123abcd; x\n' | ssh -i support_key support@server
```

prints `__MDRB_GATE__ 1 unsigned=refuse` (after a control character) and the shell's pid. The
log (`journalctl -t md-runbook-gate`, or the `log =` file) shows a `session` event. Then open a
signed runbook in the md-runbook app and run a block; `md-runbook verify --allowed-signers
/etc/md-runbook/allowed_signers file.md` checks a runbook's signature on the server itself.

## Protocol

The app's first line is `: mdrb-gate-hello ID; …`, which a plain shell runs as it is, so the
app needs no setting. The gate answers with its banner. Then one request per line, base64 for
anything that could hold spaces; replies end with the marker a plain session uses
(`\036__MDRB_<id>__ <exit>` on stdout and stderr; refusals exit 126 with the reason on stderr):

| Request | |
| --- | --- |
| `load ID MANIFEST SIGNATURE` | Check and keep a signed manifest; answers `\036__MDRB_SIGNED__ PRINCIPAL SHA256`. |
| `param ID NAME VALUE` | A parameter's value, checked against the manifest's pattern. |
| `run ID N`, `step ID N K` | Run signed block N, or its command K (0-based). |
| `raw ID TEXT` | Shell text, only where unsigned blocks are allowed. |
| `context ID` | Runs `kubectl config current-context`, for runbooks with `kube-context:` ([Kubernetes](../../docs/features/kubernetes.md)). Answered on every server, because it only reads the kubeconfig. |

The cells' shell has `MD_RUNBOOK_GATE_WHO` (the key, as logged) and, during a signed run,
`MD_RUNBOOK_GATE_RUN` (its request id), so tools on the server can log against them, as
md-runbook-probe on the [ops host](../ops/README.md) does. Neither can be set by a manifest.

A second connection with the command `pkill -TERM|-KILL -P PID 2>/dev/null; true` (what the app
sends to cancel) stops the running block of a shell this gate started for the account.

## Tests

`test/gate.test.ts` drives the script as sshd starts it (the protocol on stdin, signatures from
the real `ssh-keygen`); `test/ssh.live.test.ts` runs the app's SSH layer through it on CI's
OpenSSH server, cancelling and reconnecting included. Locally on Windows:
`MD_RUNBOOK_GATE_SH="C:\Program Files\Git\usr\bin\dash.exe" node --test out/test/gate.test.js`.

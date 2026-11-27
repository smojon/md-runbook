# Remote hosts (VS Code)

VS Code runs cells on your servers over SSH, as the [app](../app.md) does. Three ways:

- **A `host=NAME` block** runs on the host of that name.
- **Run on a Group…** (a cell's ⋯, Run ▾) runs one cell on each host of a group in turn.
- **Practice on a Host…** (Run ▾) sends every cell of the runbook to one host: drills, training.

The SSH client is built in (no `ssh` program is started).

## Your hosts

**md-runbook: Hosts…** (Run ▾, Command Palette) lists them:

- **Add Host…**: name, hostname, user, port, group.
- **Add from ~/.ssh/config…**: picks a `Host` entry and fills in its address, port and user.
- A host's **Edit…**, **Forget Host Key** and **Remove**.
- **Copy md-runbook Public Key**: for a host's `~/.ssh/authorized_keys`.
- **Key Certificate…**: a certificate from your CA for that key (see
  [Certificates](#certificates)).

They are kept in the user setting `mdRunbook.hosts`:

```json
"mdRunbook.hosts": [
  { "name": "web-1", "hostname": "web1.example.net", "user": "ops", "group": "eu-web" },
  { "name": "training-1", "hostname": "10.0.0.9", "port": 2222, "user": "trainee" }
]
```

- User settings only: a workspace's settings can't add a host or point a name elsewhere.
- Names compare whatever the case, as in the app.
- A hostname or user that starts with `-` or has a space is refused.

## Keys

- **Your SSH agent first:** `SSH_AUTH_SOCK`, or the Windows OpenSSH agent service.
  - Ed25519, ECDSA and RSA keys work. The agent signs: no private key reaches md-runbook.
  - `ssh-add ~/.ssh/id_ed25519` once per login (or the agent's own settings).
  - Certificates in the agent work too, with no setting: `ssh-add` loads `id_ed25519-cert.pub`
    with the key.
- **Else md-runbook's own key**, kept in VS Code's secret storage. **Hosts… → Copy md-runbook
  Public Key** makes it the first time.
- Key files are not read. Put a key with a passphrase in the agent.
- Each key is tried once, in order:
  - A key that can't sign (the agent refuses, a hardware key prompt is cancelled) is skipped. It
    isn't asked again, also not as its certificate. If no key logs in, the error says why.
  - The server ends the login after a few refused keys (sshd's `MaxAuthTries`, 6 by default).
    Then md-runbook connects again for the keys left, in the same connect time.
  - sshd's `PerSourcePenalties` (OpenSSH 9.8+) count each failed connection: 5 s each, refused
    from 15 s. A login past `MaxAuthTries` has one more. Behind a relay or a shared NAT, put the
    key that logs in first, or raise `MaxAuthTries`.

### Certificates

For hosts that trust your company's SSH certificate authority (CA). See
[SSH certificates](ssh-certificates.md).

- **Key Certificate…** (Run ▾, Hosts…, Command Palette) attaches one to md-runbook's own key:
  - **Copy md-runbook Public Key**: send it to your CA.
  - **Attach from File…** or **Paste Certificate…**: the `…-cert.pub` it gives back. One for
    another key, or with a CA signature that doesn't check out, is refused.
  - The menu shows its key ID, users (principals), expiry, restrictions and CA. It says whether
    the CA's signature was checked here. **Remove Certificate** takes it off.
- A login tries certificates first, at most 2, and only within their dates (5 minutes of
  leeway). The keys tried before come after them, as before: 5 from the agent, then md-runbook's.
- A warning shows before it expires and after. It comes in the last quarter of its life, at
  most a day ahead.
- A refused login says when a certificate expired, or isn't for that user.
- Kept in secret storage, with the key.

## Host keys

- The first connection shows the server's fingerprint (`SHA256:…`). **Trust** pins it.
- Nothing is sent before: no key, no command.
- A known host with another key is refused, and the output shows the new fingerprint.
- After a reinstall, **Hosts… → the host → Forget Host Key**, then run again.

## What a cell on a host gets

- One shell per runbook and host, kept between cells: `cd` and variables carry over.
- The cell's own `env.NAME=` and `cwd=` (a folder on the host).
- The values of its `${param:}`, `${secret:}`, `${input:}` and `${out:}`, as environment
  variables. Secrets are redacted from the output, as on this machine.
- A cell on a host doesn't get `mdRunbook.execution.env`, the `.env` file, injected secrets, or
  the front matter's `env:` and `cwd:`. Those are for this machine.
- Checks, captures, retries, history and the output block work as for local cells. The status
  line says `on NAME`.
- `os=` is judged against the host's system.

## Questions before a run

- **A `host=` cell:** asks before the first cell on that host, once per runbook and host. A
  runbook picks the host by name, so you see it first.
- **A risky command** (or `confirm`): asked as usual. The question names the account it runs as.
- **A group run** asks once, naming every account.

## Run on a Group…

- Pick a group: the cell runs on each of its hosts in turn.
- The output has a section per host. Its block records `group=`, `hosts=` and `failed=`, as in the app.
- Checks are judged on each host. The run fails if any host failed.
- Hosts whose key isn't trusted yet are skipped with a note. Run a cell there first.

## Practice on a Host…

- Pick a host: every cell of this runbook runs there, whatever `host=` says.
- The status bar shows **Practice on NAME**. Click it to change or stop.
- `practice: NAME` in the front matter does the same, after asking.
- The question is skipped when the whole runbook is signed by a [trusted signer](signed-runbooks.md)
  and unchanged since.
  - For your copy of a team library runbook, the keys trusted from that library count too.
- No host of that name: nothing runs. See [drills](drills.md).

## Not yet

- Signed cells don't go through md-runbook-gate from VS Code. They run as plain text, which a gate
  that only runs signed cells refuses.
- `Include`, `Match` and `ProxyJump` in `~/.ssh/config`; `known_hosts`; Pageant.
- The text editor's CodeLens ▶ runs `host=` blocks nowhere: open the file as a runbook.

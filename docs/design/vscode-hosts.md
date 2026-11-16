# Remote hosts in VS Code (design)

Goal: VS Code runs cells over SSH as the app does, with the app's rules and `packages/ssh` (no
`ssh` binary). That covers `host=` cells, **Run on a Group…** and **Practice on a Host…**.

## Where the hosts come from

- `mdRunbook.hosts`: a list of `{ name, hostname, port, user, group }`.
  - Machine scope: user settings only, never a workspace's settings, not synced.
  - A repository can't add a host or point a name somewhere else.
- `~/.ssh/config`: its literal `Host` entries (no `*`, `?` or `!`) are offered by **Hosts… → Add
  from ~/.ssh/config**. They are candidates only: a cell runs on listed hosts only.
- Names compare case-insensitively, as in the app. Refused: a hostname or user that starts with
  `-` or has whitespace, a port outside 1–65535, a duplicate name.

## Which key

`packages/ssh` takes any `KeyPair`. It can't read OpenSSH private key files (spike finding).

- **ssh-agent first.** `SSH_AUTH_SOCK`, else Windows OpenSSH's `\\.\pipe\openssh-ssh-agent`.
  - New `packages/ssh/src/agent.ts` (Node only): request identities, sign requests.
  - Ed25519, ECDSA and RSA (`rsa-sha2-512`) keys. The agent signs; no private key reaches us.
- **Else md-runbook's own key**, as the app has one: P-256, made on first use, kept in
  SecretStorage. **Hosts… → Copy md-runbook Public Key** copies its `authorized_keys` line.
- No key-file setting: OpenSSH's format isn't readable, and passphrases would pass through us.

## Host keys

- Pinned per `hostname:port` in globalState, after a modal with the SHA256 fingerprint.
- Checked in the library's `verifyHostKey`: refused before any credential or command is sent.
- A changed key is a hard refusal with a clear message. **Hosts… → Forget Host Key** is the way
  out after a reinstall.

## Running a cell remotely

- An executor wraps `pipeline.executorFor`: cells for a host go to a `RemoteSession`. One session
  per runbook and host, kept between cells (folder and variables carry over, as in the app).
- The executor returns an `ExecuteResult`: output, redaction, checks, captures, retries, status
  line and history stay the controller's.
- A new shell after a lost one, and `exit N`, get the app's notes.
- Sent: the cell's `env=`, its `${param:}`, `${secret:}`, `${input:}`, `${out:}` values (as
  environment variables, as the app does), and its `cwd=`.
- Not sent: `mdRunbook.execution.env`, the `.env` file, injected secrets, front matter `env:`/`cwd:`.
- The run records `on=user@host` (`by=`/`on=` rules as today), and the status line names the host.

## Rules that stay

- Risky patterns and `confirm` ask as today; the question names the host and account. A group
  asks once, naming every account.
- A runbook's `host=` picks a host from your list: asked once per runbook and host (as the app's
  "another host" card).
- `os=` is judged against the remote's platform, not this machine's.
- Restricted Mode: the extension doesn't run there at all (`untrustedWorkspaces: false`).

## host=, groups, practice

- `host=NAME`: runs on NAME when it is in the list, else skipped with today's message.
- **Run on a Group…** (a cell's ⋯, Run menu): the cell on each host of a group in turn.
  - One output with a section per host; `group=`, `hosts=`, `failed=` as in the app.
  - Hosts without a pinned key are skipped with a note; checks are judged per host.
- **Practice on a Host…** (Run menu): every cell of this runbook goes to that host, whatever
  `host=` says. The status bar shows "Practice on NAME"; clicking it stops practice.
- Front matter `practice: NAME` asks before it is used, unless the whole runbook is signed by a
  trusted signer and unchanged. A name not in the list stops the run, as in the app.

## Not now

- Signed cells through md-runbook-gate (they run as plain text; a gate that refuses unsigned
  cells says so).
- `Include` and `Match` in `~/.ssh/config`; `known_hosts`; Pageant; jump hosts.

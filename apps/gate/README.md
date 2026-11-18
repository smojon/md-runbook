# md-runbook-gate

The forced command of SSH keys that may only run **signed runbooks**: one static program (Go,
no dependencies) for Linux and macOS. It checks each runbook against:
- `allowed_signers`, for its signature;
- the server's policy (unsigned blocks, scopes, revoked releases, expiry);
- the parameters' patterns.

Then it runs the signed blocks in one shell per connection, and logs every request. What it is
for, and how runbooks are signed:
[docs/features/signed-runbooks.md](../../docs/features/signed-runbooks.md).

## Needs

- Linux or macOS with OpenSSH 8.2 or newer (`ssh-keygen -Y`).
- bash if the runbooks need it (else the blocks run in `sh`).

Nothing else: no `perl`, `setsid`, `stdbuf`, `fold` or `curl`.

**The programs the gate runs** come from `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin` only:
`ssh-keygen`, `id`, `locale`, `getent`, `sh`, `ps`, `sudo`, `systemd-run` and `bwrap`. With a
Job per session, `kubectl` too.
- Never from `/usr/local`, from `path =` or from the PATH sshd sets. A folder an account can
  write would let it plant its own `ssh-keygen`, which passes any signature.
- Each one, and every folder above it, must be root's and writable by root alone. Else the gate
  refuses to start, in every mode, and names the folder.
- OpenSSH installed only in `/usr/local` is not used: install your system's package.

## Install

Each release has a binary per platform: `md-runbook-gate-linux-amd64`, `-linux-arm64`,
`-darwin-amd64` and `-darwin-arm64`. Download yours and `SHA256SUMS`, and check the sum:

```sh
v=0.30.1 os=linux arch=amd64
base=https://github.com/smojon/md-runbook/releases/download/v$v
curl -fL -O "$base/md-runbook-gate-$os-$arch" -O "$base/SHA256SUMS"
grep " md-runbook-gate-$os-$arch\$" SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
sudo install -m 755 "md-runbook-gate-$os-$arch" /usr/local/bin/md-runbook-gate
```

`gate.conf` and the publishers' keys go in `/etc/md-runbook`:

```sh
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

`restrict` turns off port, agent and X11 forwarding, the pty and `~/.ssh/rc`. The gate needs it
on every key: with forwarding, `ssh -L` to `docker.sock` runs code without a signature.
- `restrict` itself: the five `no-*` options don't turn off tunnels.
- No `environment=`: with `PermitUserEnvironment yes`, `LD_PRELOAD` there runs code in the gate.
  Keep `PermitUserEnvironment no` (sshd's default). The gate also refuses to start while
  `~/.ssh/environment` exists.

Options on the command:
- `--unsigned=allow|refuse`, `--scopes=a,b` and `--signers=N` override `gate.conf` for that key;
- `--who=NAME` is the name logged for it;
- `--config=FILE` reads another config. Like `gate.conf`, it must be a file the account can't
  change (root-owned, in a root-owned folder).

The command may start with `exec`, and values may be quoted: `--who='Alice Smith'`. Anything a
shell would expand (`$`, a backtick, `;`) is refused. So is `sh md-runbook-gate`: the gate is a
program, which `sh` can't run.

With SSH certificates, put the restriction into the certificate instead:
`ssh-keygen -s ca -I alice -n support -O clear -O force-command=/usr/local/bin/md-runbook-gate alice.pub`.

**Keep the gate's files out of the account's reach.** Signed blocks run as the account, so it
must not own the program, `/etc/md-runbook/` or (ideally) its own `authorized_keys`. For
example: `AuthorizedKeysFile /etc/ssh/authorized_keys/%u` with root-owned files.

**Give the account the login shell `/bin/sh`:** `sudo usermod -s /bin/sh support`.
- sshd starts the gate with the login shell. Debian's bash runs `~/.bashrc` first, a file the
  account can write.
- Under sshd, the gate starts only with `sh`, `dash`, `ash`, `busybox`, `ksh`, `mksh`, `oksh` or
  `posh`. It refuses any other login shell.
- `login_shell_check = no` in `gate.conf` turns this off, for test servers only.

**Use the account for the gate alone,** and set `kill_leftovers = yes` (Linux). Other programs of
the account can do what a block can: through `/proc`, they can write into a session's shell.
- With `kill_leftovers = yes`, the gate ends every process of the account outside a live session.
  It does so at the start and end of each session. Such a leftover is a block's `setsid` program,
  or a cron job.
- The gate spares other SSH logins, `docker exec` and `kubectl exec`, the user manager
  (`systemd --user`) and earlier sessions' run reports. It ends the user manager's services.
- Under another account's process, only `sshd`'s counts as a login. Cron jobs and orphans
  that a root process adopted are ended.
- The gate can't end programs of a session that is still running.
- Against a fork loop the sweep is best-effort. Such a program forks and exits again and
  again, so its pid never holds still. The gate stops whole process groups and lists again.
  - A program that also leaves its process group each time can slip through.
  - When new processes keep coming for 5 seconds, the log says `sweep incomplete`.
- In separated mode the blocks' accounts need no sweep: every process of a session's account
  ends at its start and end, with or without `kill_leftovers`.

Add `ExposeAuthInfo yes` to `sshd_config` to log each key's fingerprint.

## Isolation

Each shell of a session runs in a scope of its own. When the shell ends, so does everything in
its scope, even a program that left its process group (`setsid`, a double fork).

`isolation =` in `gate.conf` picks how:
- `auto` (the default): `scope` where it works, else `none`. Never `bwrap`, so blocks that use
  `sudo` keep working after an update.
- `scope`: a systemd scope of the account's user manager (`systemd-run --user --scope`).
- `bwrap`: a PID namespace of its own (`bwrap --unshare-pid`).
- `none`: the shell's process group only, as before 0.28.0. `kill_leftovers = yes` ends the rest.

`scope` and `bwrap` are required when you name them: without them the gate doesn't start.

**Why a user scope.** A plain account can't ask the system manager for a scope: that needs root
or a polkit rule. Its own user manager can.
- Under sshd with `UsePAM yes`, `pam_systemd` starts it (`user@UID.service`).
- Without a login, `loginctl enable-linger ACCOUNT` keeps it running.
- The gate ends a scope through its cgroup (`cgroup.kill`). That needs cgroup v2 and Linux 5.14
  or newer.

**bwrap** keeps the file tree as it is. But blocks see only their own processes in `/proc`, and
nothing in it can gain privileges: no `sudo`, no setuid programs. So the gate uses it only when
you write `isolation = bwrap`.

**Limits:**
- In shared mode a block runs as the account that owns its scope. A block that means to can
  leave it, for example by asking the user manager for a service.
- A scope ends what a block leaves behind by accident, not what it hides on purpose.
- In separated mode blocks can't leave their scope. And every process of the session's blocks
  account ends at its start and end ([Separated mode](#separated-mode)).

The `session` event in the log says which isolation a session got (`isolation`), and why `auto`
found none (`isolation_off`).

## Separated mode

By default the blocks run as the gate's own account (`shared`). Then a block can read the report
token and a log file, and reach the gate through `/proc`.

With `cells_accounts = NAME …` in `gate.conf`, the blocks run as other accounts instead
(`separated`). They can't reach the token, the log or the gate's own pipes.

**Why a pool.** Any process of an account can write into that account's shells and read their
environment (through `/proc`). So each session leases an account of its own:
- A session takes the first free account of the pool and keeps it until it ends.
- Two sessions side by side never run as the same account, so their blocks can't reach each
  other.
- Make the pool as large as the sessions you run at once. When all are in use, the next session
  refuses to start: `all 4 cells accounts are in use: raise the pool`.
- `cells_account = NAME` still works: a pool of one, so one session at a time. Don't set both.

**One pool per gate account.** The leases are lock files in the gate account's state folder
(`~/.md-runbook-gate/cells/`), so another gate account can't see them. Each pool account runs
this gate account's blocks and nothing else:
- no other gate account uses it, not even one for unsigned trials;
- no cron or at jobs, no logins, no user manager (`loginctl enable-linger`);
- the login shell `/usr/sbin/nologin` or `/bin/false`. The gate runs blocks through sudo, never a
  login;
- no privileged group (`sudo`, `wheel`, `adm`, `docker`, `lxd`, `incus-admin`, `libvirt`,
  `kvm`, `disk`, `systemd-journal`, `shadow`), and no sudo rule of its own.

Give this gate its own report token, in the library server's `RUNS_SEPARATED_GATE_TOKENS`. The
server counts a summary as separated only with such a token: a shared gate's blocks can read
theirs.

Set up a pool of 4 once, as root:

```sh
pool="mdrb-cells-1 mdrb-cells-2 mdrb-cells-3 mdrb-cells-4"
for a in $pool; do
  useradd -m -s /usr/sbin/nologin "$a"
  echo "$a" >> /etc/cron.deny
  echo "$a" >> /etc/at.deny
  crontab -r -u "$a" 2>/dev/null   # cron.deny stops new crontabs, not existing ones
  for j in $(atq -q a 2>/dev/null | awk -v a="$a" '$NF == a {print $1}'); do atrm "$j"; done
done
echo 'support ALL=(mdrb-cells-1,mdrb-cells-2,mdrb-cells-3,mdrb-cells-4) NOPASSWD: /usr/local/bin/md-runbook-gate __cells' > /etc/sudoers.d/md-runbook-gate
chmod 440 /etc/sudoers.d/md-runbook-gate
visudo -cf /etc/sudoers.d/md-runbook-gate
# No SSH logins as a pool account, sftp included
echo "DenyUsers $pool" > /etc/ssh/sshd_config.d/md-runbook-gate.conf
sshd -t && (systemctl reload ssh || systemctl reload sshd)
```

Without `sshd_config.d`, add the `DenyUsers` line to `sshd_config`, above any `Match` block.

and in `gate.conf`:

```
cells_accounts = mdrb-cells-1 mdrb-cells-2 mdrb-cells-3 mdrb-cells-4
```

On Alpine (busybox cron), `cron.deny` blocks nothing: don't install cron there, or don't use
separated mode.

Here `support` is the gate's account. The sudoers line:
- names every account of the pool in one list, in any order, and no other;
- has the gate's real path and `__cells`, nothing more;
- is the gate account's only sudo rule. A line for each account doesn't count: write one line.

**Every process of the session's account ends,** at the start (before the first block) and at
the end of each session, with or without `kill_leftovers`:
- The gate runs its cells mode as that account, through the same sudo line. It calls
  `kill(-1, SIGKILL)`.
- The gate lists the processes until none of the account is left.
- If one is left (stuck in the kernel, `D` state), the session skips that account and takes the
  next free one. It logs `"event":"lease","status":"skipped"` with the reason.
- When sudo can't run the cells mode as an account, the session skips that account.
- The same when the account's home keeps a key file it can't remove (see below).
- The session refuses to start only when no free account can be cleared.
- A skipped account stays locked until that session ends. Other sessions see it as in use.
- The first session after that tries the skipped account again.
- A stuck account takes a place in the pool: keep one spare account.
- **Linux:** the kernel signals all of the account's processes at once, with its task list
  locked. A process that keeps forking can't slip out.
- **macOS:** the kernel signals a list it takes first. A process that forks just then can live
  on. The gate ends them again, up to 3 times, and skips the account while one is left.
- What a crashed gate's session left behind ends when the next session leases that account.
- At the start, an account that runs another gate account's blocks is no skip. That pool is
  shared, which it must not be. The session refuses to start, and nothing is ended.

At the start of each session the gate checks every account of the pool, then what the leased
account can read and write. That last check runs as the leased account only, once none of its
processes is left: never as an account another session holds. It refuses to start, and logs a
`self-check` event, when:
- an account doesn't exist, is root, or is the gate's own, or two names have the same uid;
- `sudo -n -l` lists anything but that one line;
- an account is in a privileged group (listed above);
- an account may use cron or at: `cron.deny` and `at.deny` must list it, or `cron.allow` and
  `at.allow` exist without it (on macOS in `/usr/lib/cron`);
- an account's login shell isn't `nologin` or `false` (`/usr/sbin/nologin`, `/sbin/nologin`,
  `/usr/bin/nologin`, `/bin/false`, `/usr/bin/false`). A block could log in over SSH, without
  `no_new_privs`;
- its home is open to other accounts and isn't its own. The gate closes a home of its own
  (mode 0700) at each lease;
- a folder above the gate's files is not safe (see below);
- the leased account can read `report_token_file` or the `log =` file;
- it can change the gate's program, `gate.conf`, `allowed_signers`, the account's keys or the
  gate's state;
- it can't enter `/tmp`;
- the gate can't see other accounts' processes (`/proc` mounted with `hidepid`), or no free
  account can be cleared (above).

The message names the problem and the line to write. The gate can't check whether an account
has sudo rules of its own (`sudo -l -U` needs root): don't give it any.

**Key files in a pool home.** A block can leave `~/.ssh/authorized_keys`. A key there could log
in as the account and reach a later session.
- At each lease, the leased account removes `.ssh/authorized_keys` and `authorized_keys2` from
  its home.
- If a block closed its own `.ssh`, the account opens it to itself first.
- The gate logs `"event":"lease","status":"removed"` with the files.
- When the account can't remove a file (in a folder of root's), the session skips that account.
- Only these two default files are checked. A custom `AuthorizedKeysFile`, `.k5login` or
  `.shosts` are not.
- `DenyUsers` for the pool is the actual control. Keep it in `sshd_config`.

**Safe folders,** as OpenSSH's `StrictModes` asks for its files. The gate checks every folder
from each of its files up to `/`:
- the files: the gate's program, `gate.conf`, `allowed_signers`, `revoked`, `floors`, the
  account's keys, `report_token_file` and the `log =` file;
- each folder must be root's or the gate account's;
- no pool account may be able to write it, as anyone or through one of its groups;
- a sticky folder such as `/tmp` is fine if the entry below it is root's or the gate account's.

Some images leave `/usr/local/bin` or `/opt` open. Then install the gate in a folder only root
can change, such as `/usr/libexec/md-runbook-gate`. The message names the folder to fix.

**Where blocks run:**
- **Folder:** a shell starts in its account's home folder (else `/`). A block's `cwd=` must be a
  folder every pool account can enter. Give them access with a group or an ACL.
- **Environment:** as in shared mode, but `HOME`, `USER` and `LOGNAME` are the leased
  account's, and there is no `TMPDIR`. Programs use `/tmp`.
- **Files:** what a block writes belongs to the leased account. `kubeconfig =` must be readable
  by every pool account.
- **Work folder:** in `/tmp`, which the blocks' account may enter but not list. The shell
  appends each run's exit to a file there that only the gate can read. The gate writes the
  `end` events to the log itself.
  - A line in that file the shells didn't write ends the session, and logs an `exits` event.
    The session's run reports don't go out then.
- **Stopping:** stop requests and the end of a session reach the blocks through the same
  `sudo` line.
- **No new privileges (Linux):** the cells start with `no_new_privs`. In blocks in separated
  mode, these don't work:
  - `sudo`, `su` and other setuid programs;
  - programs that need file capabilities, such as `ping`, `traceroute` or `mtr` on older
    distributions.

  Use shared mode for blocks that need them.
- **Log:** the `session` event names the leased account (`cells`).

**What separated mode doesn't cover:**
- **Within a session** a block can still answer for the later runs of its runbook
  ([Trust](#trust)). It can also change a line of its session's exits file in place, if the
  line keeps its form: the gate doesn't see that.
- **Files outlive a session.** Processes end, but what a block leaves in its account's home or
  in `/tmp` stays.
  - A later session on the same account can read those files. It can also be affected by them.
  - Config that tools load can run code. For example:
    - `~/.kube/config`, through an `exec` plugin;
    - `~/.gitconfig`, through a hook path or a pager;
    - `~/.ssh/config`, through `ProxyCommand` or `LocalCommand`;
    - Python's user site folder, through a `.pth` file.
  - The gate doesn't wipe the homes: you may provision config there on purpose.
  - Provision what blocks need read-only: root-owned files and folders.
  - Keep one pool for runbooks of the same trust level.
  - For strict isolation between untrusted runbooks, use a Kubernetes Job per session (below). Each
    session gets a fresh pod.
  - A setuid file that a block leaves can't lift a later block on Linux: `no_new_privs`.
  - The gate closes the account's home to other accounts at each lease.
  - macOS has no `no_new_privs`. There, a setuid file a block leaves in `/tmp` lets any
    account act as its owner. Use Linux where sessions must stay apart.
  - On Linux too, an account outside the gate can run such a file. Mount `/tmp` with `nosuid`.
- **A shared pool.** Two gate accounts with the same pool don't see each other's leases. The
  gate refuses when it sees the other's blocks, but two sessions that start at the same moment
  can share an account.

Run reports say which mode ran the blocks: `gate.gate_mode` is `shared` or `separated`
([Run reports](#run-reports)).

The [ops host](../ops/README.md)'s pod can't change accounts. There, `cells_runner =
kubernetes-job` runs each session's blocks in a Kubernetes Job of their own instead
([A Job per session](../ops/README.md#a-job-per-session)). It counts as `separated` too.
- `job_service_account = NAME` is required: the Job's service account.
- `job_image = IMAGE` is optional: the default is the gate's own pod's image.
- The gate needs a pod to run in, and `kubectl` in `/usr/bin` like its other programs. The
  runner doesn't go with `cells_accounts`, `cells_account` or `isolation = scope` or `bwrap`.
- At the start of each session the gate checks both service accounts, and refuses to start if
  either has a right it shouldn't.
- A `job_service_account` of your own needs `get` and `list` on `namespaces` cluster-wide, else
  the gate refuses with "can't list the namespaces". With a private registry, put the
  `imagePullSecrets` on that service account: the Job names none
  ([details](../ops/README.md#a-job-per-session)).
- The pod's start takes from seconds to a minute, depending on the cluster. It doesn't count
  against the client's time limits (protocol 4, below).
- A Stop at the exact moment the session's pod becomes ready may let the block run up to 2 s more.
- When the connection drops during the session's first block, the block runs to its end, as any
  block does. Only within 5 s of the pod getting ready does the session end at once, as for a Stop.

**Why not `systemd-run --uid`?** It needs root, or a polkit rule that also lets the account
start units as root. sudo can name one command and the accounts it may run as.

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
- a key without `restrict`;
- a key that turns something on again: `port-forwarding`, `permitopen`, `permitlisten`, `pty`,
  `user-rc`, `X11-forwarding`, `agent-forwarding`;
- a key with `environment=`, or a `--config=` the account can change;
- a mix of signed and unsigned keys: give the unsigned ones their own account;
- a file it can't read.

The check reads key lines with their options (`restrict`, `from=`, quoted values) and
`cert-authority` lines too. In `authorized_keys =`, `%h`, `%u`, `%U` and `%%` work as in sshd;
any other `%` token is an error.

What it can't see, so keep this account for the gate alone and without a password:
- keys from `AuthorizedKeysCommand`, and the principals of SSH certificates;
- password or keyboard-interactive logins;
- other programs running as the same account.

With `ForceCommand` in `sshd_config` (as on the [ops host](../ops/README.md)), set
`sshd_force_command = yes`. Then every login runs the gate whatever the key lines say, and
`unsigned` in `gate.conf` decides the kind alone. Because the key lines go unchecked:
- `gate.conf` and its folder must be root-owned, not writable by the account. Else the gate
  refuses to start.
- `sshd_config` needs `DisableForwarding yes`, `PermitTTY no` and `PermitUserRC no`.
- The gate refuses to start while `~/.ssh/rc` exists.
- `sshd_force_command = yes` and `--sshd-force-command` on the `ForceCommand` line go together:
  one without the other stops the gate. A key line may not have the option.

## The blocks' shell

- **A shell for each runbook:** `bash --noprofile --norc`, else `sh`. Functions, aliases,
  traps, options and variables of another runbook don't carry over.
- **The blocks of one runbook share it,** as in a plain session: `cd`, variables and `set -e`
  carry over.
  - Loading the same runbook again keeps it, also after a call into another runbook.
  - A session keeps up to 6 such shells. A 7th runbook ends the one used least recently.
- **Unsigned text** (where allowed) never runs in a shell a signed runbook gets later. The next
  signed block, or loading that runbook again, starts a fresh shell.
- **Background programs** of a block get TERM when its shell ends, and KILL a second later.
  Each shell leads a process group and session of its own.
  - A program that leaves the group (`setsid`, a double fork) still ends with the shell's
    scope ([Isolation](#isolation)). Without one, only `kill_leftovers = yes` ends it, when the
    session ends.
- **No profile:** not `/etc/profile`, `~/.profile` or `~/.bashrc`. The account can write those,
  so they would run in every signed block.
- **PATH** is `path =` in `gate.conf` (default `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`).
  Add the folders of tools such as `kubectl` there, root-owned folders only.
- **Locale:** `locale =` in `gate.conf` (default `auto`: `C.UTF-8` where the system has it, else
  `C`). The client's `LANG` and `LC_*` never reach a block.
- **Environment:** only `HOME`, `USER`, `LOGNAME`, `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`,
  `TERM`, `TZ` and `TMPDIR` from what sshd set. Proxies, `NODE_OPTIONS` or `KUBECONFIG` from
  `environment=` never reach a block.
  - `SHELL` is the blocks' shell.
  - `KUBECONFIG` is `kubeconfig =` in `gate.conf`, or a block's signed `env.KUBECONFIG`.
- **kube-context:** a block signed with `kube-context=NAME` (or `kube-context=${param:NAME}`)
  runs only while `kubectl config current-context` says that context. The gate checks it
  itself, after the block's `env.*`, and refuses otherwise (exit 126). The front matter's
  `kube-context:` isn't signed: only the app checks that one.
- **No files in between:** the gate keeps the verified manifest, the parameters and the runs in
  memory. It sends each block's code to the shell through an unnamed pipe only the gate holds.
  - The block runs as the body of a function: `return` ends it, and `BASH_SOURCE` is empty.
  - The shell writes each run's exit to the work folder with a random number. A line for
    another run counts only with that run's number.
- **Limits:** a request longer than 4,000,000 bytes ends the session, and the gate reads no more
  of it. The gate holds at most `memory_limit =` MiB (default 512; 0: none): a session that
  needs more ends. The blocks get no limit from the gate.
- **Parameter patterns** are POSIX extended regular expressions, read byte by byte as `grep -E`
  reads them in the C locale. GNU extensions (`\d`, `\w`, `\b`, back-references) match nothing.

## Trust

**A signed block is trusted code.** It runs in the same shell that reads what the gate sends
next. So it can:
- read the code, parameter values and random numbers of the later runs in its shell;
- answer for them: their output, exit and report line, without running them.

A run report is only as good as the blocks of its runbook. Sign only blocks you would run as the
account yourself.

Signed blocks run as the account. So a gate is only as strong as the account around it:
- **Use `unsigned = refuse` for every key of the account**, or the gate's checks prove nothing.
  An unsigned block can change anything the account can.
- **Use `log = syslog`.** A block can edit a log file the account can write.
- **Reports that say "sent by a gate" need both.** A block can read `report_token_file` and send
  reports of its own.
- **After any time with `unsigned = allow`**, change the report token. Remove what the account
  may have planted in its home folder and crontab.

[Separated mode](#separated-mode) takes the token and the log out of the blocks' reach, and
runs each session's blocks as an account of its own. A block can still answer for later runs of
its own runbook, as above.

## Check it

From a machine with the support key:

```sh
printf ': mdrb-gate-hello 0123abcd; x\n' | ssh -i support_key support@server
```

prints `__MDRB_GATE__ 4 unsigned=refuse` (after a control character) and the session's number.
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

The banner's number is the protocol (4). The app sends a request only to gates whose protocol
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

**Pod notices (protocol 4).** With `cells_runner = kubernetes-job`, a request can wait for the
session's pod. The gate says when, so that the pod's start doesn't count against the client's
time limit.

Only a client whose hello is `: mdrb-gate-hello ID pod-notices; …` gets them; older gates read
that hello as before. Each notice is one line, `\036__MDRB_POD__ STATE`:
- `job`, after the banner: the cells run in a Job whose pod isn't ready yet;
- `starting`, on stderr, before a request whose reply waits for the pod;
- `ready`, on stderr, once: the request runs;
- `failed REASON`, on stderr, once: the pod won't come, and the session ends.

After `job`:
- the gate says `ready` or `failed` before any block runs;
- no notice comes after them, so a block's output can't fake one;
- a client reads notices until one of them comes, also after a refusal;
- a client that goes during the wait ends the session, and the gate deletes the Job at once.

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
- the gate's mode: `gate.gate_mode` is `shared` or `separated`;
- each signed block's label (the first line of its code) and state.

It never holds an output or a parameter value.

The gate sends them itself, in the background after the session. It tries 3 times, 10 seconds
each, and logs a `report` event (`sent` or `failed`, with the HTTP status). It never holds up or
fails a run.

- It reads no file of the account and no proxy setting: a block could have written them.
- The sender follows no redirect.
- An unsigned-trial account sends none ([All signed or none](#all-signed-or-none)).
- A report says "sent by a gate" truthfully only under the conditions of [Trust](#trust).

The [library server](../library-server/README.md) keeps it as verified when the token is one of
its gate tokens. Give each gate its own token:
- in separated mode, in the server's `RUNS_SEPARATED_GATE_TOKENS`;
- otherwise in `RUNS_GATE_TOKENS`. The server refuses `gate_mode: "separated"` with one of these.

More in
[signed runbooks](../../docs/features/signed-runbooks.md#run-reports-from-the-gate).

## Build and test

The Go module is this folder: `cmd/md-runbook-gate` and `internal/…`, standard library only.

```sh
cd apps/gate
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o dist/md-runbook-gate ./cmd/md-runbook-gate
go vet ./... && gofmt -l . && go test ./...
```

- `go test` checks the parsers and checks: gate.conf, key lines, requests, manifests,
  signatures (with the real `ssh-keygen`), patterns and the leftover sweep's choices.
  `MD_RUNBOOK_GATE_GREP=1` also compares the pattern cases with GNU grep.
- `test/gate.test.ts` drives the binary as sshd starts it: the protocol on stdin, signatures
  from the real `ssh-keygen`. `MD_RUNBOOK_GATE_BIN` names the binary (default
  `apps/gate/dist/md-runbook-gate`).
  - Isolation: the tests take what the machine has. `MD_RUNBOOK_GATE_ISOLATIONS=scope,bwrap`
    makes them fail where one is missing.
  - Separated mode needs accounts and a sudoers line, so it runs in CI only (the `gate` job).
    `MD_RUNBOOK_GATE_ACCOUNT` runs the gate, `MD_RUNBOOK_GATE_CELLS_ACCOUNTS` (2 or more,
    separated by spaces) the blocks, and
    `MD_RUNBOOK_GATE_WIDE_ACCOUNT` has a wider rule the self-check must refuse. The tests run
    them with their own `sudo`.
- `test/ssh.live.test.ts` runs the app's SSH layer through it on CI's OpenSSH server, cancelling
  and reconnecting included.

From Windows, build with `GOOS=linux` and run the tests in WSL:
`MD_RUNBOOK_GATE_BIN=$PWD/apps/gate/dist/md-runbook-gate node --test out/test/gate.test.js`.

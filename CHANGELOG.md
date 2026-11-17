# Changelog

## Unreleased

**Gate admins:** md-runbook-gate is now a program, no longer a shell script. Install the binary
for your server's platform when you update.

- **Gate: a binary per platform.** Linux and macOS, amd64 and arm64:
  `md-runbook-gate-<os>-<arch>` on each release, with `SHA256SUMS`. Check the sum, then install
  it as `/usr/local/bin/md-runbook-gate` ([apps/gate](apps/gate/README.md#install)).
  - The protocol, `gate.conf`, the key-line options and the log events are unchanged. The app,
    VS Code and the command line need nothing new.
- **Gate: only OpenSSH is needed** (8.2 or newer, for `ssh-keygen -Y`). No more `perl`,
  `setsid`, `stdbuf`, `fold` or `curl`.
  - The gate gives each block's shell a process group of its own on every server.
  - The gate sends run reports itself, in the background as before.
  - The gate runs `ssh-keygen` and its other programs only from `/usr/bin`, `/bin`,
    `/usr/sbin` and `/sbin`, never from `/usr/local` or the PATH. Each one, and every folder
    above it, must be root's alone, or the gate doesn't start
    ([Needs](apps/gate/README.md#needs)).
- **Gate: `allow_no_group_kill` is ignored.** A `gate.conf` with it still starts, and each
  session logs a `notice`. Remove it when convenient.
- **Gate: a key line can't run the gate through a shell.** `command="sh …/md-runbook-gate"` is
  refused, since `sh` can't run a program. Name the gate alone.
- **Gate: `memory_limit`** now bounds what the gate holds: a session that needs more ends.
- **Gate: parameter patterns** still read as `grep -E` reads them. GNU extensions such as `\d`
  or `\w` now match nothing, as signing already refuses them.
- **Gate: each shell in a scope of its own (`isolation =`).** When a shell ends, everything in
  its scope ends too, even a program that left its process group (`setsid`, a double fork).
  - The default is `auto`: a systemd scope of the account's user manager where it works, else
    process groups as before.
  - `isolation = bwrap` gives each shell a PID namespace instead. `auto` never picks it.
  - `scope` and `bwrap` are required when you name them: without them the gate doesn't start.
    `none` keeps the old behaviour.
  - Under `bwrap`, blocks can't use `sudo` or setuid programs. Set `isolation = scope` or `none`
    if your blocks need them.
  - The `session` log event says which one a session got.
  - See [Isolation](apps/gate/README.md#isolation).
- **Gate: separated mode (`cells_account =`).** Blocks run as a second, unprivileged account,
  through one `sudo` line. It is off by default.
  - Blocks can't read the report token or the log, nor reach the gate's pipes.
  - At the start of each session the gate checks the setup, and refuses to start if it is wrong.
    The message says what to fix.
  - The check refuses a `sudo` rule wider than the one line, and a token or log the blocks can
    read.
  - The check refuses a folder above the gate's files that the blocks' account can change, as
    OpenSSH's `StrictModes` does.
  - One blocks' account per gate account. The check refuses any process of that account outside
    this gate account's sessions, and an account that may use cron or at.
  - The check refuses an account in a privileged group, such as `sudo`, `adm` or `docker`.
  - Blocks start in that account's home folder. A block's `cwd=` must be a folder it can enter.
  - Not for the ops host: it stays shared.
  - See [Separated mode](apps/gate/README.md#separated-mode).
- **Gate: run reports say the mode.** The summary's `gate` object has `gate_mode`: `shared` or
  `separated`.
- **Visual Studio Marketplace by trusted publishing:** the release publishes there with
  `vsce publish --oidc`, no token, once the policy and the variable `MARKETPLACE_TRUSTED_PUBLISHING`
  are set ([PUBLISHING.md](PUBLISHING.md)). `vsce` for publishing is 4.1.0.
- **Gate binaries on each GitHub release:** `md-runbook-gate-linux-amd64`, `-linux-arm64`,
  `-darwin-amd64` and `-darwin-arm64`, with `SHA256SUMS`. Built static, with the Go toolchain
  `apps/gate/go.mod` names, by a job without secrets.
- **Ops host image:** builds the gate from its Go source in a build stage, from a `golang` image
  pinned by digest, and installs only the static binary.
- **Dependabot:** follows the gate's Go modules (`apps/gate`) weekly, with the same 7-day wait as
  the actions.
- **Run reports: the gate's mode.** A gate's summary can say how its blocks ran:
  `gate.gate_mode` is `shared` or `separated`. See
  [run reports](docs/features/run-reports.md#a-gate-in-separated-mode).
  - It counts only in a summary sent with a gate token. Without it, the summary counts as
    `shared`; any other value is refused.
  - The library server shows `verified: sent by a gate (separated)` or `(shared account)`, and
    keeps `gateMode` with each gate's run.
- **`report-runs-required: separated`:** required as `true` is, and only a report from a gate in
  separated mode counts as the run's.
  - VS Code, the app and the command line say so in the notice.
  - The library server's last green run counts only such a run when its library copy asks for it.
  - Any other value of `report-runs-required` is now a lint error.
- **Gate and clients: one reading of a manifest.** Shared test vectors
  (`apps/gate/testdata/vectors.json`, `npm run gate-vectors`) check that the gate reads each
  manifest, fence option, name and request as core does. Where they differed, both now take the
  stricter reading:
  - The gate refuses a manifest clients can't read. It no longer runs cells listed after `end`.
  - Two cells with one number, or two `code` or `param` lines, are refused. Before, the gate
    took the first and clients the last.
  - Values must be canonical base64.
  - An `expires` date must exist (`2026-02-31` doesn't).
  - A `kube-context=` key written with the Kelvin sign (K) is read by the gate too.
  - `kube-context=` written twice on a block is an error, and only ASCII blanks are trimmed from
    its value.
  - A parameter value with a CR is refused by the gate, as clients already did.
- **Signed parameter patterns: one reading everywhere.** Signing, the gate and the clients accept
  only patterns that `grep -E` and they read alike. A value can no longer leave the anchors.
  - Unbalanced parentheses are refused: `a)|(b` matched any value starting with `a`.
  - Also refused: a backslash in brackets or before a letter (`[a-z\-]`, `\t`), `[:alpha:]`
    without its outer brackets, doubled or lazy repetitions.
  - Runbooks signed with such a pattern must be signed again: the gate refuses them now.
  - `__proto__`, `constructor` and `prototype` can't be parameter or `env.*` names.
- **Signing:** refuses a front matter `kube-context:` while a bash block has none of its own. The
  gate only checks the block's.
  - Names ending in `_proxy`, in any case, are refused: Python reads `Https_Proxy`.
  - Manifests over 2.9 MB are refused: the gate's load request would be too long.
- **`report-runs-required` written twice:** the strictest counts, in clients and lint alike
  (before, clients took the last and lint said the first). Signing still refuses it twice.
  - Lint checks each line's value too: a misspelt `separated` on the second line is an error.
- **Sign these again.** Runbooks signed before this release stop verifying, and the gate refuses
  them, if they have:
  - a parameter or `env.` name ending in `_proxy` (rename it);
  - `kube-context=` written twice on a block (keep one).
- **Co-signing:** a runbook signed with a front matter `kube-context:` and a block without its
  own `kube-context=` still verifies, but can't be co-signed. Write `kube-context=` on each bash
  block, sign it again, then co-sign. Co-sign Runbook now says why it refuses.
- **Library server: separated gates get their own tokens.** Only a token in the new
  `RUNS_SEPARATED_GATE_TOKENS` may send `gate_mode: "separated"`. A shared gate's blocks can read
  its token, so the server no longer takes the mode from the summary alone.
  - `separated` with a token of `RUNS_GATE_TOKENS` is refused (`400`).
  - A token in both lists stops the server at start. Give every gate its own token.
- **Library server: `report-runs-required: separated` for every spelling of a runbook.**
  `last-green` applies it to `deploy`, `x/deploy.md` or `prod/Deploy.markdown` when they match
  the runs of `prod/deploy.md`.
  - A library it can't read counts only a separated gate's run, and says why
    (`requiredUnknown`).
- **VS Code:** reports runs of a runbook that writes `Report-Runs:` in another case, as the app
  and the command line do.
- **VS Code, team library: a library's signers count for its runbooks only**, as in the app.
  - **Add the Team Library's Signers…** keeps them apart from your own allowed_signers file,
    one file per library address, as the app keys them.
  - The Library view, your copies of its runbooks, run reports and Practice on a Host use them.
    Links, the command line and the gate are unchanged.
  - **Trusted Signers…** lists yours first, then each library's under its address.
  - A key the library no longer publishes is withdrawn: it stops counting until published again.
  - Keys an earlier version put in your own file stay there, marked as also published by the
    library. Remove them to trust them for its runbooks only.


## 0.27.0

Security fixes from five review rounds, a team runbook library in VS Code and the app, and a
hardened release pipeline.

**Gate admins:** key lines, login shells and the leftover sweep changed. Read the Gate items
below before you update.

- **Command line, signed runs (`--allowed-signers`):** a front matter changed after signing is
  refused. Before, its `env:`, `cwd:` or `shell:` applied though the run said "signed, unchanged".
  - A version 1 signature doesn't cover the front matter: such a runbook can't set those.
- **Signed runbooks: one reading of lines.** A lone CR now ends a line everywhere, as in
  CommonMark. Before, it hid the front matter from some readers while the runbook still counted
  as signed as a whole.
  - A runbook with lone CRs that was signed before may need signing again.
- **Signed runbooks: the front matter as signed.** A note, run record or signature block above
  the front matter, or a note inside it, now makes a runbook changed since signing.
- **Signed runbooks: what a run adds.** Notes, outputs and run record signatures are set aside
  only in the exact form md-runbook writes. HTML after a note's marker now counts as a change.
- **Signing:** a bash block inside an HTML block such as `<script>`, `<pre>` or `<div>` is
  refused, as one inside a comment already was.
- **Older signatures (version 1):** links and signed runs accept only labels in the front matter,
  such as `title:` or `incident:`. See [signed runbooks](docs/features/signed-runbooks.md).
  - Before, `practice:`, `manual-steps:`, `report-runs:` or a parameter's default still counted
    as signed.
- **Copy with values (VS Code and the app):** a value after `$(`, a backtick or `@(` stays a
  reference. Before, a value from a link could end its quotes there and run when pasted.
  - PowerShell values starting with `-` are quoted, so they are no parameter names.
  - In VS Code, a cmd value with a metacharacter stays a reference instead of a warning.
- **VS Code inputs:** an input written `${input:NAME:secret}` in one block is secret in every
  block. Before, a block using `${input:NAME}` showed and copied the secret value.
- **Add Note:** a lone CR in a note no longer starts a line outside its quote, where a block
  could run.
- **Output markers:** a value can no longer end the marker's comment. Values are capped at 200
  characters, but for a call's paths.
  - Dashes, brackets, quotes and line breaks are escaped as `%XX`, and read back as they were.
  - Notes and outputs written before, such as `by=jean--luc`, still leave a signed runbook
    unchanged.
- **Command line, call copies:** the record of copies is written through a new file of a random
  name. On Linux and macOS, a record folder or file others can write is not used.
  - A continued copy runs as read for its checks, not read again.
- **Saved outputs (VS Code and the app):** a secret printed to stderr in two packets is now
  redacted. Before, a stderr mark between the packets kept it from matching, and the file got it
  in clear.
  - The app's live output hides a known secret split this way too.
- **App, live output:** a token split across two packets no longer shows its end, such as a JWT's
  signature. The raw output is redacted, never output redacted before.
- **App, confirmations:** Run on a confirmation card runs only the values it showed. A value
  changed since, by a link for example, asks again.
  - A link no longer fills its values into a runbook that is running or waiting for an answer.
    It opens a new copy and says why.
  - A link no longer fills its values into a call's copy either.
- **Copy with values (VS Code and the app):** a command with a comment gets no values. Before,
  the apostrophe in `# don't` opened a quote, and a value from a link could run when pasted.
  - The same holds for bash heredocs (`<<EOF`) and PowerShell here-strings (`@"…"@`, `@'…'@`).
  - A reference after the shell's escape character, such as `\${param:X}`, stays a reference.
- **Signed runbooks: output fences.** An output block is set aside only with the fences md-runbook
  writes. Before, a fence indented 4 spaces showed its "output" as prose on GitHub, while the
  runbook still counted as signed.
- **Signing: tags alone on a line.** A bash block after a line such as `<span>` or `<a name="x">`
  is refused. GitHub shows such a block as text, not as code that runs.
- **Expo updates workflow:** the pull request's title, commit and text come from the checked
  names and versions only. Before, text from the job that ran npm went in as it was.
- **Expo updates workflow:** a changed lock entry may have only the keys npm writes. Its engines,
  os, cpu and bin must be the registry's, and its version at least 7 days old.
  - A new shrinkwrap is refused, and `npm ls` checks the tree from the lock.
- **TestFlight workflow:** the build's archive is checked with case ignored, as on the Mac. A name
  twice, or a path through a symbolic link, is refused.
  - Before, `plugins/` passed the check for app extensions, and a later file could replace one.
- **Library server, devices tokens:** a new token under the same label may update or remove the
  phones of the old one while both are accepted. Before, a rotation got `409`.

- **Relay:** with `RELAY_TARGETS=*:22`, other spellings of loopback and private addresses got
  through, such as `[0:0:0:0:0:0:0:1]:22` or `[::ffff:7f00:1]:22`. The relay now parses each
  address, and also refuses multicast and reserved addresses.
  - A NAT64 address counts as the IPv4 address in it. So a relay on an IPv6-only network with
    DNS64 still reaches public hosts.
  - Only the usual NAT64 forms (`64:ff9b::a.b.c.d`, `64:ff9b:1::a.b.c.d`). The rest of
    `64:ff9b::/32` is refused, such as `64:ff9b::ffff:a00:1`.
- **Links (app and VS Code):** a runbook from a link counts as signed only when its signature
  verifies against a key you trust. That holds for **Open only signed runbooks from links** too.
  - Before, any well-formed signature block was enough.
  - For a whole-runbook signature, changed text around the blocks also counts as unsigned now.
  - An expired signature counts as unsigned, and so does an older signature with an added
    PowerShell or cmd block.
  - An added PowerShell or cmd block next to an older signature counts as unsigned, as does an
    expired one.

  - VS Code checks against `mdRunbook.signing.allowedSigners`.
- **Library server:** `ALERT_MAP` needs `ALERTS_TOKENS`, so nobody else can post alerts.
  `ALERTS_ALLOW_ANYONE=true` keeps the old behaviour, for a private network only.
- **Library server:** only the devices token a phone registered with can register it again
  (`409` for another one). Before, any other devices token could mute the phone or take it off.
  - Give each person their own `DEVICES_TOKENS` entry: a shared read token is one owner.
- **Library server:** an older release of a signed name is refused at any path, not only where it
  was published. Before, `old/ops/restart.md` could bring back version 3 of `ops/restart`.
- **Gate and signing:** a manifest with a second `name`, `version`, `expires` or `scope` line
  is refused. Before, the gate read the first one and the rest of md-runbook the last. A version
  must be a whole number and `expires` a date.
- **Ops host in Kubernetes:** runbooks may change workloads only in the namespaces you bind, and
  never DaemonSets. Before, they could patch any namespace's workloads, close to cluster-admin.
  - After an upgrade, run one `kubectl create rolebinding` per namespace (apps/ops/README.md).
- **Web container:** no other site can show the app in a frame (`frame-ancestors 'none'`,
  `X-Frame-Options: DENY`).
- **Gate: a fresh shell for each runbook.** It is `bash --noprofile --norc`, with `path =` and
  `locale =` from `gate.conf`. Before, `bash -l` ran the account's profile, a file the account
  can write, in every signed block.
  - Another runbook's functions, traps, options and variables no longer carry over. The blocks of
    one runbook still share their shell.
  - A runbook keeps its shell after a call into another runbook, which gets a shell of its own.
  - The client's `LANG` and `LC_*` no longer reach the blocks.
  - Add the folders of your tools to `path =` if they aren't in `/usr/local/bin`, `/usr/bin` or
    `/bin`.
- **Gate: `kube-context=` is enforced on the server.** A signed block runs only while kubectl's
  current context is the one it names. Before, a client could skip the check.
  - Signing now keeps the pattern of a `kube-context=${param:NAME}`. Sign such runbooks again,
    and update the app.
- **Gate: all signed or none.** The gate reads the account's `authorized_keys`. It refuses to
  start if a key skips the gate, or if signed and unsigned keys share the account.
  - An account whose keys allow unsigned blocks sends no run reports.
  - With `ForceCommand`, set `sshd_force_command = yes`. The ops host image does this.
  - A key's command may start with `exec` and quote its values, such as `--who='Alice Smith'`.
- **Gate: the work folder.** The gate keeps the verified manifest and the parameters in memory.
  Before, a block could plant a parameter for the next one.
- **Gate: no file between the check and the shell.** Each block's code goes to its shell through
  a pipe only the gate holds. Before, a program could swap the file after the hash check.
  - Before, a program of the account could write commands into the named pipe a block's shell
    read.
  - Programs already running as the account are out of the gate's reach. Use the account for
    the gate alone.
- **Gate: background programs** of a block get TERM when its shell ends, and KILL a second
  later. Before, they outlived both, and a program that ignored TERM ran on.
  - A program can leave the shell's process group (`setsid`), and could then write into a later
    session's shell.
  - With `kill_leftovers = yes`, the gate ends such leftovers at the start and end of each
    session (Linux). The ops host image sets it.
  - Without `setsid` and `perl`, the gate refuses to start. `allow_no_group_kill = yes` starts it
    anyway.
- **Gate: `kill_leftovers` sweep.** A program that forks and exits in a loop is now stopped by its
  process group. Before, it slipped through and could write into a later session's shell.
  - Against a loop that also leaves its group each time, the sweep is best-effort.
  - The user manager (`systemd --user`) is now spared. Before, it was killed at every session.
  - Only processes under `sshd` count as other logins. Before, orphans adopted by a root
    process survived.
  - When the client left first, the end of the session no longer kills `sshd` running as the
    account. Before, the ops host container restarted.
- **Gate: run reports** count only the exit the shell wrote for that run. Before, a block could
  add a passing exit for a failed run.
  - The reported signer comes from the gate's memory. Before, a block could change it in a file.
- **Ops host: the account's login shell is `/bin/sh`.** With bash, sshd ran `~/.bashrc`, a file
  the account can write, before the gate.
  - Under sshd, the gate refuses any login shell but `sh`, `dash`, `ash`, `busybox`, `ksh`,
    `mksh`, `oksh` and `posh`. Run `usermod -s /bin/sh` for the account.
- **Gate: every key needs `restrict`.** Without it, port forwarding stays open, and `ssh -L` to
  `docker.sock` runs code without a signature.
  - Key options that turn forwarding, the pty or `~/.ssh/rc` on again are refused too.
  - The five `no-*` options don't count instead of `restrict` any more: sshd's tunnel check
    looks for `restrict` itself.
- **Gate: the gate's own environment.** A key with `environment=` is refused, and so is a
  session while `~/.ssh/environment` exists. With `PermitUserEnvironment yes`, `LD_PRELOAD`
  there ran code in the gate.
  - The gate also clears `LD_*`, `BASH_ENV`, the proxy variables, `CURL_*`, `SSL_*` and the like
    before it starts a program.
- **Gate: a key's `--config=`** must name a file the account can't change. Else the account
  could set its own policy and signers.
- **Gate: `sshd_force_command = yes`** counts only in a root-owned `gate.conf` the account can't
  write. Before, `--sshd-force-command` on a key line switched off the check of the keys.
  - It also needs `--sshd-force-command` on the `ForceCommand` line: one without the other stops
    the gate.
- **Gate: unsigned blocks** never run in a shell that a signed runbook gets later. Before, unsigned
  text sent before the first load shared that runbook's shell.
  - After unsigned text, the next signed block starts a fresh shell, as a new load does. Before,
    it ran in the shell the unsigned text had changed.
- **Gate: a request longer than 4,000,000 bytes** ends the session. The gate reads no more of it.
  Before, a 32 MB line took 67 MB and 24 seconds, and the session went on.
  - The gate's own processes get at most `memory_limit = 512` MiB (the blocks are not limited).
- **Gate docs: a signed block is trusted code.** It can read what its shell gets next, and
  answer for later blocks of its runbook. A report is only as good as the runbook's blocks.
- **Gate: the blocks' environment** comes from a short list, such as `HOME`, `USER` and
  `SSH_CLIENT`. Before, proxies or `NODE_OPTIONS` from sshd's `environment=` reached the blocks.
  - `KUBECONFIG` comes from `kubeconfig =` in `gate.conf`, or from a block's `env.KUBECONFIG`.
- **Gate: `authorized_keys =`** expands `%U` and `%%` as sshd does, and any other token is an
  error. Before, the gate didn't read such a file.
- **Gate: cancelling** stops every program of the running block, not only the shell's children.
  The stop request names a random session number, so other sessions can't stop it.
- **Gate and signing:** more names are refused as parameters and `env.*`. Among them are
  `NODE_OPTIONS`, `PYTHONPATH`, `GIT_SSH_COMMAND`, the proxy variables and `SSL_CERT_FILE`.
  - Also `GIT_ASKPASS`, `EDITOR`, `PAGER`, `LESSOPEN`, `OPENSSL_CONF`, `AWS_CONFIG_FILE` and a
    few more.
- **Gate:** an empty scope list and a missing `--config=` file are now errors. Before, they
  meant every scope and the built-in defaults.
- **Gate:** run reports no longer read the account's `~/.curlrc`.
- **Ops host:** md-runbook-probe ignores a `# comment` after `log =`, as the gate does.
- **Gate and ops host docs:** a gate's word needs `unsigned = refuse` for every key and
  `log = syslog`. After any time with unsigned blocks, make a new ops host key.
- **Runbook calls (VS Code and command line):** a call run again continues only a run copy of
  the runbook called. Before, an edited `copy=` in its output could name any file.
  - The copy must be next to it or in the copy folder, named after it, with the same blocks.
  - For a signed runbook, the copy must have the same signed name and version.
  - The copy's front matter must be the one a new copy gets. Before, a planted copy could bring
    its own `env:`, `kube-context:` or choices.
  - A copy's steps count as done only when md-runbook on this machine wrote it. Before, planted
    outputs could skip a guard or a backup.
  - Otherwise a fresh copy runs, and the call's output says why.
- **Runbook calls:** a value in `src=` fills part of one file or folder name. Before, a link's
  `TO=../../elsewhere/evil` could make `src="releases/${param:TO}.md"` run any runbook.
  - A value with `/`, `\` or `:` is now an error before anything runs.
- **Parameters with choices (`One of: a, b`):** a value from a link, a call, the default or
  `--param` must be one of them too. Before, only the input box checked it.
  - VS Code doesn't take such a value from a link, and asks for it instead.
- **Confirmations (VS Code and command line):** risky patterns now see the command with its
  values filled in. Before, `kubectl ${param:VERB}` with `VERB=delete` never asked.
  - The dialog shows those values; secret ones stay `${secret:…}`.
  - In VS Code, a cell with placeholders asks once their values are known, not before.
- **VS Code, redaction and AI settings:** a workspace's `redaction.patterns`, `ai.terms` and
  `ai.internalDomains` are added to yours. Before, a workspace setting `[]` replaced your list.
- **VS Code on Windows, recorded context:** focusing a runbook could run a `kubectl.cmd` planted
  next to it. Context commands now look on `PATH` only.
  - The status bar's first look runs them in your home folder.
- **Cloud console views (VS Code):** an AWS link takes only a real region. Before, a crafted
  zone or ARN in the output could point **Open** at another host.
  - Values in the table stay text: a resource name can't make a link, an image or HTML.
- **VS Code, Set Parameters and Set Inputs:** only the extension test runner can pass them
  values. The commands themselves always ask.
- **VS Code, cells on a host:** a cell's `env.NAME=` value goes to the host as written. Before,
  a secret from `mdRunbook.secrets.inject` or a `.env` value of that name went instead.
  - With cell options off, no `env.NAME=` value goes to the host.
- **Library server, pushes:** a phone keeps a digest of the devices token it registered with.
  A new token under the old label no longer brings back the phones of the old token.
  - `DELETE /v1/devices/<id>` needs the token the phone registered with.
- **Library server, pushes:** one devices token registers at most 50 phones
  (`PUSH_MAX_DEVICES_PER_TOKEN`). Before, one token's holder could fill the whole list.
  - A phone whose token the provider refuses 3 pushes in a row is removed, while other phones get
    them. This covers APNs `BadDeviceToken`.
- **VS Code, Open from Library:** the runbook opened is the text the library read checked. Before,
  a stale row or another extension could pass other text under a verified runbook's verdict.
- **VS Code, Practice on a Host and Run on a Group:** a host or group passed by a keybinding or
  another extension is asked about first. Before, practice started, or the cell ran, at once.
- **VS Code, Trusted Signers:** a line added from a paste, a file or the team library must name
  each signer. A pattern such as `*` or `*@example.net` is refused, with why.
- **VS Code, Copy Line with Values:** each value is quoted for the cell's shell, inside or outside
  quotes. Before, a value such as `x; rm -rf ~` was pasted as a command.
  - In cmd blocks the value is copied as it is, with a warning when it has `& | < > ^ %` or `"`.
- **VS Code links without ssh-keygen:** the message says signatures can't be checked, and to
  install OpenSSH. Before, it said the runbook was not signed or pinned.
- **Links (VS Code and app):** a version 1 signature no longer counts when the front matter sets
  `env:`, `cwd:`, `shell:`, `mode:`, `kube-context:`, `kube-context-mode:` or `timeout:`.
  - Such a signature covers the blocks only. The command line's signed runs refuse the same keys.
- **Whole-runbook signatures:** a note or a run record's signature inside a code block now counts
  as code. Before, adding one to a cmd or PowerShell block left the runbook signed as a whole.
  - A signed runbook with note-shaped lines in its code blocks needs signing again.
- **App, alerts on this phone:** each server gets only its own devices token. Before, moving the
  team library sent the new server's token to the old one, to remove the phone there.
- **App, tokens and redirects:** alert registration and the assistant's Anthropic key never follow
  a redirect, like library uploads. Before, a redirect took the devices token along.
  - An answer that shows a redirect anyway is refused, and the request isn't sent again.
- **App, Edit Note and Delete Note:** they change only a note outside code, in the cell of its ⋯.
  Before, a note-shaped line in a code block could change instead.
  - Any line break in the words stays inside the note. Before, a lone carriage return could start
    a code block.
- **App, Run on a Group:** a runbook with a `practice:` host the app doesn't have can't run on a
  group. Before, the group run went ahead on the real hosts, while a plain run stopped.
- **App, Start Incident copies:** a copy whose front matter was edited, such as `practice:` or
  `kube-context:`, no longer counts as signed as a whole. Before, a changed `practice:` host ran
  without asking first.
- **App, parameters with choices (`One of: a, b`):** a block run on its own refuses a value that
  isn't one of them, as Run all does. A link's value outside them is not taken, and the banner
  says so.
- **App, confirmations:** risky patterns see the command with its values filled in, as in VS Code.
  Before, `kubectl ${param:VERB}` with `VERB=delete` ran without asking.
- **App, a link opened again:** it reopens its earlier copy only while that copy is the runbook the
  link gives, apart from outputs and notes. Before, an edited copy opened as signed.
- **App, questions and runs keep to their step:** confirm cards, group runs, Run all and a step's ⋯
  act on their own step, wherever it moved. A step that changed or went is not run, and the notice
  says so.
  - Before, rejecting a proposal above a waiting confirm card made **Run** run the next step,
    unconfirmed. During a group run, later hosts could run another step.
  - Outputs and a call's result go to the step that ran. Before, an output could land on a step
    with the same code and another `host=`.
- **App, Approve and Reject:** they act on the proposal you read, and only on a proposal. Before,
  Approve could approve another step, and a stale ⋯ could delete a step of yours.
- **App, runbook calls:** a failed call continues its copy only when the app wrote that copy, and
  its front matter is still right. Before, a copy planted under the right name was continued, with
  its fake "done" steps.
- **App, front matter:** a run stops when the front matter changes, such as `practice:`,
  `kube-context:`, `shell:` or `mode:`. Before, a paused Run all went on under the new values.
- **App, your patterns:** risky and redaction patterns you add run under RE2, which can't hang.
  - A pattern with look-around stays JavaScript, up to 200 characters and without nested
    repeats such as `(a+)+`. Such a pattern is refused.
  - Live output is redacted before it is cut to its last 20,000 characters.
  - A secret split across two packets no longer shows in part.
- **Web app:** a relay at `ws://[::1]` is refused, with why. The page's policy blocks it.
- **Web app on GitHub Pages:** the team library publishes only `.md`, `.markdown`, `index.json`
  and `allowed_signers`. Before, an `.html` file there ran as a page next to the app.
- **App, Record where each step ran:** the context is kept to 200 characters, without control
  characters or line breaks.
- **App, copies of a library runbook:** their front matter and notes are read as the rest of
  md-runbook reads them, lone carriage returns included. Before, a front matter written that way
  went unseen when the copy's signature was checked.

- **App: Suggest a Fix.** A failed step's ⋯ and the Steps header ask the assistant for a fix.
  It lands after the step, as a proposal to approve.
- **App: Forget Learned Times.** ⋯ More → Values forgets this runbook's learned step times, or
  every runbook's, after a confirmation.
- **App: Uncheck All Lines.** **Uncheck all** sits next to **Run checked lines**, and in the
  cell's ⋯, as in VS Code.
- **App: Copy Line with Values.** A line's actions copy its command with parameters, inputs and
  captured values filled in. Secrets stay references.
  - Each value is quoted for the block's shell, so a pasted value stays one piece of text.
  - In a cmd block, a value with `&`, `|`, `%` or another cmd metacharacter stays a reference.
- **App: Pause Before This Step, Notify Me When It Starts.** A step's ⋯ (cell or Steps row) sets
  either, for this session. Run all asks Continue or Stop there.
  - Marks and breakpoints stay on their step when cells are added above, as by a proposal or a
    note. A step whose code changes loses them, and the app says so.
  - Run all stops before a step it still had to run once that step's code changes.
- **App: the launch form.** Run all first shows one sheet with what the run needs and does.
  - It lists parameters, inputs, secrets to set, risky steps, steps by hand, time and host.
  - Risky steps include a risky setup, ready check or teardown.
  - Start asks for no value again; risky steps still ask.
  - Hosts & Settings turns it off; ⋯ More → **Run All…** always opens it.
- **App: Edit Note, Delete Note.** A note's ⋯ edits its words in place, or deletes it after a
  confirmation. Its time, author and milestone stay as VS Code wrote them.
- **App: Show Runs…** (⋯ More → Run, and the Steps header) lists this runbook's runs, newest
  first.
  - Each says when, who, how long, and which steps passed or failed.
  - The device keeps the last 30 runs, never their outputs.
- **App: Publish to Library…, Remove from Library…** (⋯ More → Share, and a Team runbooks row's
  ⋯), as in VS Code.
  - Only a runbook signed as a whole and unchanged goes in; otherwise **Sign Runbook** comes first.
  - Hosts & Settings sets the server and its upload token, kept in secure storage (on the web,
    in this browser).
- **App: Edit as Text, New runbook….** A runbook opens as text in its own screen: Edit, Preview,
  or back to Runbook.
  - Edit has Save, Undo, Discard and the lint problems.
  - Saving warns before a matching signature breaks.
  - The start screen's **New runbook…** starts blank or from a small template.
- **App: a runbook's practice: host asks first.** Front matter `practice:` asks once before every
  cell runs on that host, as `host=` does. A whole runbook verified-signed, or a host you picked,
  doesn't ask.
- **App: imported hosts that join your groups are marked.** Import hosts marks each new host that
  joins a group you already have, since Run on a Group would include it.
- **App: a hardware key that fails is no longer replaced silently.**
  - A software key is made only when the phone's keystore can't make such keys, and never with
    Face ID or a fingerprint on.
  - Other failures show under Hosts & settings, with Try again.
- **Android: "ask before each use" asks at each use.** On Android 11 and later, a key made with the
  switch on asks for every signature, not once per 10 seconds. Turn the switch off and on to make
  such a key.
- **App: copies of a library runbook keep its rules.** Run All as Copy and Start Incident are off
  while the library refuses the runbook, and say why. Their copies run only while the library
  would open them.
- **Web: a key the browser can't export, and a Content Security Policy.**
  - New web keys are WebCrypto keys the browser won't export.
  - An earlier key stays; Hosts & settings offers to replace it.
  - The page runs only its own scripts, never inside another site's frame.

- **App: the safety settings of VS Code.** Hosts & settings has them, with VS Code's defaults.
  - Risky commands lists the patterns that ask before a cell runs. Add or remove them one by one.
  - Hiding secrets in output adds your patterns to the built-in ones, also for live output.
  - Stop a cell after sets the timeout of cells without `timeout=`. The default is none, no
    longer 10 minutes.
  - Stop Run all at a failed step is on by default. Off, Run all goes on to the next step.
- **App: every action in sight.**
  - Each row of the Steps view has a ⋯ button for its actions; a long press still works.
  - The start screen has a ⋯ sheet with its actions, the sample, the cheat sheet and settings.
  - A cell with several commands says that a tap on a line shows its actions, until you tap one.
  - A proposal's ⋯ has **Reject Proposed Cell**, as in VS Code.
- **App: runbook calls get the checks of VS Code.**
  - A failed call continues its copy only if that copy is still the runbook called. A signed
    runbook also needs the same name and version.
  - Another copy is not continued: a fresh one runs, and the call's output and the copy's screen
    say why.
  - A value in `src=` with a slash, a backslash or a colon is refused before anything runs.
- **App: Record where each step ran** (Hosts & settings → Running cells), off by default.
  - Each output marker gets the host's Kubernetes context as `context=`, and the account as `on=`.
  - The context comes from a step's own `kube-context` check when it has one.
  - The launch form and the Steps header show the newest run's context, also one VS Code
    recorded.
- **App: Get Started.** A short tour on the start screen covers the sample, a first run, a host,
  the team library and help.
  - It shows once on the first start, with Skip on every card.
  - The start screen's ⋯ → **Get Started** shows it again.


- **VS Code: Publish to Library… and Remove from Library…** (Share ▾) send a signed runbook to
  the team library server, or take one out. The upload token stays in VS Code's secret storage.
  An unsigned runbook gets a **Sign Runbook** button first.
- **VS Code: the Library view** (Runbook activity bar) lists your team library by folder, as the
  app's Team runbooks do. Each row says whether its signature is verified against your trusted
  signers. Opening one makes your own copy.
- **VS Code: Trusted Signers…** (Share ▾) lists, adds and removes the signers in your
  allowed_signers file. It adds a pasted line, a public key, or the team library's signers.
- **VS Code: remote hosts.** A block with `host=NAME` runs on that host over SSH, as in the app.
  **Hosts…** (Run ▾) keeps them in the user setting `mdRunbook.hosts`, or takes them from `~/.ssh/config`.
- **VS Code: Run on a Group…** (a cell's ⋯, Run ▾) runs one cell on each host of a group.
  The output has a section per host. A risky cell asks once, naming every account.
- **VS Code: Practice on a Host…** (Run ▾) sends every cell of a runbook to one host.
  The status bar shows Practice on NAME. A front matter `practice:` asks first, unless the runbook
  is signed by a trusted signer.
- **VS Code, SSH keys and host keys:** the keys of your SSH agent sign, else md-runbook's own key.
  A host key is trusted once, after its fingerprint is shown. A changed key is refused.
- **SSH client:** logs in with SSH agent keys (Ed25519, ECDSA, RSA), on Windows through the
  OpenSSH agent service.
- **Command line: `md-runbook unpublish PATH --library URL`** removes a runbook from a team
  library, where its server allows deleting.

Alerts to phones and TestFlight, both off until set up
([docs/push-and-testflight.md](docs/push-and-testflight.md)).

- **Library server:** firing alerts are pushed to registered phones, through Firebase on Android
  and APNs on iPhones.
  - Phones register with `POST /v1/devices` and a devices token (`DEVICES_TOKENS`).
  - A push carries the alert's name, its runbook and its link. No other labels or annotations.
  - Phones the provider reports as gone are removed.
- **App:** Hosts & settings → Alerts on this phone registers the phone with the team library's
  server.
  - A tap opens the alert's runbook through the usual link checks. Nothing runs by itself.
  - A build without Firebase or the APNs entitlement shows the setting as not set up.
- **TestFlight:** a workflow builds, signs and uploads the iOS app on `v*` tags. It skips until
  the Apple secrets exist.
- **VS Code: Retry Failed Step, Resume from Failed Step and Answer the Waiting Step** are in the
  Command Palette and Run ▾. They show only after a failure, or while a step waits.
- **VS Code: the launch form's Start** needs a value for each parameter without a default, as in
  the app. The form names the parameters still empty.
- **VS Code, signature checks:** an edit to your allowed_signers file counts at once. Before, the
  Library view and run reports kept the answer from before the edit.
- **VS Code without ssh-keygen:** the Library view says it can't check signatures, and to install
  OpenSSH. Before, it said the signer wasn't trusted.
  - Run reports and Practice on a Host say so too.


## 0.26.8

The Android APK is signed with the app's own key and attached to each release. Progress and notes are fixed.

- **README:** the comparison with Runme names our web and phone apps; Runme's browser version
  is VS Code on your own machine.
- **Android app:** the APK is signed with the app's own key, not the template's public debug key.
  Each release has it attached (`md-runbook-X.Y.Z.apk`). Uninstall a debug-signed copy once first:
  Android won't update an app across keys.
- **Release pages:** the notes no longer break mid-sentence. Each paragraph and list item is one
  line, as GitHub shows every line break.
- **Prose ratchet:** `--prose-baseline` counts a long sentence only past 25 words, where
  `prose: strict` warns. One of 21 to 25 words stays a hint and no longer fails CI. Baselines drop.
- **App, Add Note:** a note goes right after the step it's about, as in VS Code: the step running,
  else the last one run. Before, it went to the end. Its confirmation, **Saved** and the record
  signed message show in green, not red.
- **App, sample runbook:** its service check now quotes its regular expression. The
  `unknown cell option` warning is gone, and the check looks for `active (running)` as meant.
- **Progress, re-runs:** a run counts the steps it hasn't reached yet as still to do. Before, their
  green output from the last run counted as done: 98 %, `0s left` and an end time already past.
  VS Code and the app.
- **Estimates:** a run under 10 s rounds up to whole seconds, not to 5 s. A 5.1 s block now
  learns `~6s`, not `~10s`; clicking its time writes `estimate=6s`. VS Code and the app.

## 0.26.7

The Getting Started pages, the example runbooks and the last READMEs follow the prose rules.

- **Docs:** the Getting Started pages, the example runbooks, the contributor handoff and the
  remaining READMEs follow the prose rules. The handoff's release and VS Code issue notes are
  current again.

## 0.26.6

A cell's own `env.NAME=` now wins over the `.env` file. The sample runbook follows the prose rules.

- **Behaviour change, VS Code:** a cell's own `env.NAME=` option now wins over the same name in
  the `.env` file (`mdRunbook.execution.envFile`). Before, the file won.
- **Docs:** the sample runbook (**Open Sample Runbook**) follows the prose rules. The lint docs say which
  quotes the source hint skips (under 6 words, in table cells).

## 0.26.5

VS Code now refuses unsigned reports when a runbook requires signed ones.
Quotations no longer trip the prose check.

- **Behaviour change, VS Code:** a runbook that requires signed run reports doesn't run without
  a signing key, as in the CLI and the app. Set one in `mdRunbook.signing.key`. Before,
  it ran when the report wasn't also required, and its summary went unsigned.
- **VS Code, CodeLens runs:** with `mdRunbook.cellOptions.enabled` off, the front matter's `cwd:`
  and `timeout:` no longer apply, as in the runbook view.
- **Docs:** the environment order, the environment of assistant cells, and when a run of several
  cells asks for its values.
- **Prose checks: quotations.** See [Quotations](docs/features/lint.md#quotations).
  - A quotation (`“…”`, `«…»`, `"…"`) counts as one word. This replaces the 60 % rule.
  - No rule reads a quotation's words, and the same quote in 3 files is no duplicate.
  - New hint: a quotation of 6 words or more needs a link in its paragraph.
  - A block quote that ends in its source line (a link, or `— Name`) isn't checked.

## 0.26.4

Six more docs pages follow the prose rules, and two prose check fixes.

- **Prose checks:**
  - A citation whose link wraps over lines is no part of the sentence before it.
  - `md-runbook lint --prose-show` takes several patterns: `--prose-show 'docs/*' README.md`.
- **Six more docs pages follow the prose rules:** Kubernetes, the library server, approval, AI
  context, history, and the CodeLens and report page.

## 0.26.3

Prose checks count more cases right, and six docs pages follow the prose rules.

- **Prose checks count two more cases right:**
  - A capital after a lowercase word ends a sentence: "design B. The renewal…". Initials still don't: "J. R. R. Tolkien", "by L. Peter Deutsch".
  - A citation after a sentence, on the same line, is no part of the next sentence.

## 0.26.2

Prose checks you can tune, with boxes and fewer false alarms.

- **Prose checks: limits of your own, boxes, and new hints.** See [Prose](docs/features/lint.md#prose).
  - `.md-runbook-prose.json` can set the limits (`"limits"`) and the box limits (`"boxes"`).
  - A box's labelled paragraph may have 5 sentences and 100 words.
  - `prose: strict` warns only past 25 words a sentence.
  - New hints:
    - an empty lead-in before a code block (`Now run:`);
    - a total duration, in a runbook with estimates;
    - choppy sentences, and a bullet that leans on the one before;
    - a box split in paragraphs, or one that repeats the text above it.
  - Over many files: text said in 3 files or more.
  - Fewer false alarms:
    - a guard skips sentences with a digit, code, a link, or words such as "only" and "never";
    - fewer padding words;
    - no note for a file's average;
    - citations, initials, quotes and labels such as "Did you know?" count right;
    - a question in emphasis (`*Can it read it?* turns red`) ends no sentence;
    - a short sentence with a link is a pointer, not a duplicate;
    - a lead-in that says "shortened" or "the last lines" is not empty.

## 0.26.1

Prose checks: md-runbook points at text that could be shorter and simpler.

- **Prose checks: keep runbooks short and simple.** See [Prose](docs/features/lint.md#prose).
  - They flag:
    - a sentence over 20 words;
    - a file averaging over 15 words a sentence;
    - a paragraph of over 3 sentences or 60 words;
    - filler: openers, sentences that only announce, padding words;
    - a sentence that says its heading again, or one said twice.
  - They are info: VS Code lists them under Infos, and lint never fails on them.
  - `prose: strict` in the front matter makes them warnings. `prose: off` turns them off.
  - `md-runbook lint --prose-baseline FILE` checks a whole repository: no file may get worse.

## 0.26.0

Shorter texts in the app, and the gate's log says which alert a run answered.

- **Update the gate on your servers** to log alerts: older gates are sent no note and work as before.

- **Trust these signers is easier to read:** a question (**Trust these keys for the team library
  at …?**) and five short points, instead of one long paragraph (about 14 lines on a phone).

- **The app's texts are shorter.** A text that said one thing is now one short sentence; one
  that said several (help under a setting, warnings, prompts such as pairing, the app's key, run
  reports, trusted signers, notifications) is a title and short points, one idea each. The
  warnings keep what matters (a secret in a pairing code, a server that vouches for itself, why a
  run doesn't start); the details moved to the [app's docs](docs/app.md).

- **The gate's log says which alert a run answered.** A run started from an alert link now
  carries the link's `ALERT`, `ALERT_FINGERPRINT` and `ALERT_STARTS_AT` to md-runbook-gate (the
  new `note` request, gate protocol 3), which logs them with the runbook's load; `md-runbook
  audit` shows them next to the runs: `ops/restart-api v7 · for alert ApiDown (fingerprint
  5f3c9e, started 2026-11-14T08:58:00Z)`. Like a call's `called by`, it is only what the app
  says: it grants nothing and runs nothing, and the gate checks the values strictly. Update the
  gate on your servers to log alerts; older gates are sent no note and work as before.

- **`md-runbook sign` counts on from a signed `--out` copy.** Signing an unsigned source into an
  existing signed copy of the same runbook made it version 1 again, which servers and team
  libraries that saw a higher version refuse. The default version is now one more than the
  higher of the source's and the copy's, and the result line says where the previous one came
  from. A `--version` not above the copy's is signed as asked, with a note.

- **Pair a device:** changing **Public address of this web app** while the card is open now
  updates the libraries' addresses in the code and link too (it kept the old ones until the card
  was opened again).

## 0.25.1

A fix for team libraries that open verified runbooks only.

- **Team library (verified runbooks only): no Update for a version the library wouldn't open.**
  A row offered **Update** and **Keep mine** for a library version that was changed since
  signing, or older than one seen before, although Update then refused it. Now such a version is
  not offered: the row says **The library's version can't be taken, so your copy stays as it
  is** and why. Offers wait until the library's version is checked.

## 0.25.0

Pairing helps you check a team library's signers on your second device.

- **Pairing compares the library's signers with your other device.** A pairing code or link now
  also carries, for each team library the sending device trusts signers from, the library's
  address and those keys' fingerprints (**With the signers this device trusts for N libraries, to
  compare**). The other device keeps them as a hint only: its **Trust these signers** prompt marks
  each key **Your other device trusts this key** or not, and says **The same keys your other
  device trusts for this library** or that they differ. A link never trusts a key and can't add
  one; you still decide. Older apps ignore the new field.

## 0.24.2

A privacy fix for pairing links in the web app.

- **Web app: a pairing link's token leaves the address bar.** Opening a **Copy pairing link**
  link kept `/pair#mdrb-pair.v1.…` (with the relay's token) in the address bar and that history
  entry, where a synced browser history or a screenshot would show it: the app removed the
  fragment, then the router wrote it back. The pair screen now replaces its route, and the web
  smoke test checks the address in a real browser (and that a QR code is drawn there). If you
  opened a pairing link with 0.24.0 or 0.24.1, delete that entry from the browser's history,
  or give the relay a new token.

## 0.24.1

A fix for the web app's QR codes.

- **Web app: QR codes work.** In the browser, **Pair a device** blanked the page with
  "n is not a function", and the other QR codes (a runbook's QR card, Share hosts, the library's
  code) failed the same way: the web bundle loads the QR library's ES module, where core took
  the CommonJS one. The phone apps, VS Code and the command line were not affected.

## 0.24.0

A library server for teams, pairing a phone's browser from a laptop, and links that open the
library's own copy. Highlights, then every change below.

- **The library server** (`ghcr.io/smojon/md-runbook-library-server`, new, amd64 and arm64)
  runs next to the web app. It publishes signed runbooks into the team library (whole-runbook
  signatures from its `allowed_signers` only, versions only go up; `md-runbook publish` from CI),
  collects run summaries from VS Code, the app, the CLI and now the gate itself (`report_to` in
  `gate.conf`), answers "last ran green", and turns Alertmanager alerts into links that open the
  right library runbook. Nothing is pushed to phones yet.
- **Pair a device:** the web app shows a QR code (or **Copy pairing link**) that sets up
  another device's browser with this server's relay, and optionally your hosts. The web app
  finds a relay on its own server by itself, and shows the device's key to add to
  `authorized_keys`.
- **The web container** reads `MD_RUNBOOK_PUBLIC_URL` (the address links and QR codes use) and
  `MD_RUNBOOK_LIBRARY` (the library's folder, default `/runbooks/`).
- **A runbook link into the team library opens your library copy** (with Update / Keep mine),
  and a runbook's QR code can link to its address, pinned to its hash, instead of carrying the
  whole text.
- **In the app's Steps:** a chapter with one step is one row, and while a run waits the header
  says what for.

No Android APK is attached yet.

- **The web app on a phone, paired from a laptop.** This sets up a phone's browser for a web app
  reached through a tunnel or a reverse proxy.
  - **This server's relay:** when the web app's own address answers `/v1/server-info` as a relay,
    Hosts & settings → Relay fills in the address. You enter only the token. An address you set
    is never replaced.
  - **Pair a device** (Relay, on the laptop) shows a QR code with the relay's address and token,
    and optionally the hosts with their host keys. It warns that the code holds a secret and hides
    after a minute (**Show again**). **Copy pairing link** gives `https://<web app>/pair#…`: the
    token is in the fragment, which browsers never send. The app reads it once, removes it from
    the address bar and asks **Set up the relay from this link?** first.
  - **Pair with another device** (Relay, on the phone) scans the code with the browser's camera.
    That needs an https page; on http the app says so and points to the link.
  - Host keys from a pairing are trusted only if you tick it, as for an imported hosts list.
    Afterwards the phone shows its own key (Copy, QR code) under **Add this key to the server's
    authorized_keys**.
  - **Hosts lists** (Share hosts) may name the relay's address, never its token. No token is ever
    in a URL's query.
- **The web app's public address:** share links, QR codes and pairing links use the address other
  devices reach the web app at, not the one the page was opened from. Set it with the container's
  `MD_RUNBOOK_PUBLIC_URL`, or in Hosts & settings → **Public address of this web app**.
- **The library folder:** the web container's `MD_RUNBOOK_LIBRARY` (default `/runbooks/`, e.g.
  `/sop/`) moves the team library to another path. The container writes both settings to
  `/config.json` at start (in `/tmp`, read-only friendly, no secrets) and refuses invalid values
  ([apps/web](apps/web/README.md#settings)).
- **Show QR Code links to the runbook's address** when it came from one (a team library copy, a
  `url=` link): `/open?url=…&sha256=…`. The code is small for any size and pinned to the text
  without outputs. Runbooks without an address still travel in the code (`rb=`). The card says
  which kind it shows ([QR codes](docs/switching.md#qr-codes)).
- **A runbook link into the team library opens the library copy:** its outputs, Update / Keep
  mine, the link's parameters and host. It no longer opens a second copy. The library's rules
  hold: a library that opens verified runbooks only refuses an unverified file through a link
  too.
- **The library server (apps/library-server).** A small service, with its own container image,
  that runs next to the web app on the same name, behind the same reverse proxy.
  - **Publishing:** `POST /v1/library/runbooks/<path>`, with an upload token. It takes a runbook
    only when the whole runbook is signed by one of the library's `allowed_signers` (checked with
    ssh-keygen, as the gate checks it), unchanged since signing, not expired, named as its file,
    and of a higher version than any published at that path. It writes the file into the folder
    the web app serves, atomically, and writes `index.json` again. Deleting is off unless
    `LIBRARY_ALLOW_DELETE=true`.
  - **`md-runbook publish FILE --library URL`** sends one from the command line or CI (token in
    `MD_RUNBOOK_LIBRARY_TOKEN`).
  - **Run summaries:** `POST /v1/runs` is an address for `report-runs:`. It checks summaries
    strictly, checks runner signatures against `RUNS_ALLOWED_RUNNERS`, and keeps them
    append-only, marked `runner-signed`, `gate` or `unverified`. `RUNS_REQUIRE_SIGNED=true` refuses
    the unverified ones. `GET /v1/runs` and `/v1/runs/last-green` (`last ran green by X at T`)
    need a read token.
  - **Alertmanager:** `POST /v1/alerts` maps each alert (alertname and label matchers, in a JSON
    alert map) to a library runbook. It records the alert with the link that opens that runbook,
    pinned to its hash, with `host` and parameters taken from the labels, and `ALERT`,
    `ALERT_FINGERPRINT` and `ALERT_STARTS_AT`. `GET /v1/alerts/recent` lists them. Nothing is
    pushed to phones yet: that needs Firebase and APNs credentials.
  - See [apps/library-server](apps/library-server/README.md).
- **md-runbook-gate sends run reports.** With `report_to` (and `report_token_file`) in
  `gate.conf`, the gate sends a run summary of each signed runbook a session ran when the session
  ends, whatever client ran it. The summary is client `gate`: signed name, version, manifest
  hash, signers, the key, the server, and each signed block's result. It is sent with curl in
  the background, never holds up a run, and is logged as a `report` event. The run summary
  format gets client `gate` and its `gate` field (still version 1). See
  [run reports from the gate](docs/features/signed-runbooks.md#run-reports-from-the-gate).
- App: in Steps, a chapter with one step is one row, the heading with the step's name under it, as
  in VS Code. While Run all waits, the header says what for (`Take it down now? Stop the lab`,
  `Done by hand? …`, `Confirm …`, `Values to fill in: …`), not `100% · nothing left`.
- fflate 0.8.3, for [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)
  (a malformed ZIP64 archive could make `unzipSync` loop). md-runbook only deflates and inflates
  runbook links with it and never unzips, so it was not affected.

## 0.23.0

The Steps view in VS Code and the app, a team runbook library, whole-runbook signatures and run
reports. Highlights, then every change below.

- **Before you re-sign runbooks: update every client first.** New signatures are version 2 and
  cover the whole runbook (front matter, prose, checklists, PowerShell and cmd blocks). Gates
  already installed run them unchanged, but VS Code, the app and the CLI at 0.22 or older show a
  version 2 signature as damaged. Old (version 1) signatures still verify and now show as
  "these steps verified" (partly signed).
- **The Steps view** in VS Code (its own side bar) and in the app (a Runbook | Steps switch on
  phones, a side panel on wide screens): every step by name with its state and time, what each
  will need before you run, answers to the questions a run asks (Done / Skip / Stop, Take down /
  Leave it up), Retry and Resume after a failure, and "last ran green".
- **A team runbook library** hosted next to the web app (`/runbooks/`, or a folder you set),
  also on the phones by address, link or QR: your own copy of each runbook, Update / Keep mine,
  signature states checked in the app, signers trusted per library, `signedOnly`.
- **Run reports:** with `report-runs:` in a runbook, VS Code, the app and the CLI send a summary
  of each run (no outputs, no values) where it says, after asking you; signed with your own key;
  required by a signed runbook if it says so; `md-runbook verify-run` checks them.
- **In VS Code:** a launch form before Run All, notifications, failure triage with the
  assistant, Run Until Here / Pause Before / Notify Me, learned estimates, keys and screen-reader
  labels, tools for VS Code's agent mode.
- **In the app:** notifications when a run is done, fails or waits for you; preflight; the
  library and run reports above.

No Android APK is attached yet.

- **Run reports.** With `report-runs: https://…` in a runbook's front matter, VS Code, the app
  and the command line send that address a short summary at the end of every run.
  - **What's in it:** which runbook (name, title, hash, signed version), who ran it, where and
    when, each step's label, result and duration, and which alert the run answered (the `ALERT`,
    `ALERT_FINGERPRINT` and `ALERT_STARTS_AT` parameters). Never an output, a value or a secret.
  - **Consent:** you are asked once per address (Allow / Not now / Never), unless
    `mdRunbook.reports.allowedAddresses`, the app's settings or `--report-to-allowed` allow it.
  - **Signing:** the summary is signed with your SSH key when one is set (namespace
    `md-runbook-run`). `md-runbook verify-run ENVELOPE --allowed-runners FILE` checks it.
  - **Required reports:** `report-runs-required: true` and `report-runs-signed: true` make the
    report, and its signature, a condition of running. They count only in a runbook signed as a
    whole by a signer you trust: VS Code's new `mdRunbook.signing.allowedSigners`, the app's
    **Trusted signers** (the same list as the team library's), or `--allowed-signers`.
  - **Delivery:** a report that can't be sent is queued and tried again; it never slows a run.
  - **Limit:** in the end a client can't be forced to report. Enforcement on the server comes
    next.
  - See [run reports](docs/features/run-reports.md).
- **Signed runbooks: the whole runbook is signed (manifest version 2).**
  - New signatures also cover the text: prose, front matter, checklists, PowerShell and cmd
    blocks. Outputs, notes and ticked boxes are left out.
  - Runbooks signed before still verify, and show as **partly signed** (only their bash blocks).
  - A block now counts as signed only with the placeholders it was signed with: `${X}` turned
    into `${input:X}` no longer does.
  - A signer name must be one that allowed_signers can hold.
  - Gates already installed run the new signatures unchanged.
  - From the signature review.

- **VS Code: the launch form.** **Run All…** (Run ▾, the Steps view's ⋯) shows, in the Steps view,
  one sheet before a run: the parameters with their descriptions and choices, the inputs, the
  secrets not stored yet (**Set** each), the risky steps with their commands, the steps by hand,
  the time and the context. **Start** runs without asking for the values again; the risky steps
  still ask when they run. Run All opens it too when there is something on it
  (`mdRunbook.execution.launchForm`, on by default). From the VS Code review's feature ideas.
- **Parameter descriptions and choices:** a `params:` item's comment is its description, and a
  trailing `One of: staging, prod` lists the values allowed
  (`- TARGET: staging  # Where to deploy. One of: staging, prod.`). The linter warns when the
  default is not one of them.

- **App: Team runbooks, a library hosted with the web app.** Whoever hosts the web app puts
  runbooks in a `runbooks/` folder (a read-only volume or files built into an image; nginx lists it
  as JSON, or an `index.json` names titles and folders), and every user sees them under **Team
  runbooks**, grouped by subfolder. Opening one makes the user's own copy; when the file on the
  server changes, the copy offers **Update** (the new version's signature checked again; outputs
  of unchanged blocks kept; asks first when some would be lost, or when the signature is dropped,
  from another signer, partly covering, expired or of an older version) or **Keep mine**. Each
  runbook shows its signature, the same in the list and in the opened copy: **Signed by …: whole
  runbook verified** (manifest version 2, text as signed) or **these steps verified** (signed
  before: the bash blocks only, the prose not claimed), checked in the app against signers the
  user trusts; **Partly signed** (an older signature with PowerShell or cmd blocks outside it),
  **Signed, unknown signer**, **Not signed**, **Changed since signing** (also any text change of a
  version 2 signature), with the signed name and version, and flags for a name that is not the end
  of the file's path, a version older than one of this file seen before and an expired signature.
  A library's `allowed_signers` is offered under **Trust these signers**, with names, what a
  pattern lets a key sign as, and fingerprints, never trusted silently; trust counts for that
  library only, with the options the library publishes now, and keys it stops publishing stop
  counting (remembered while it can't be read). `"signedOnly": true` opens verified runbooks only
  (and refuses one signed under another file's name), stays on in the app if index.json stops
  asking, until the user agrees, and holds wherever a copy is opened: a copy that isn't verified
  any more runs nothing and says why, and its row offers **Replace with the library's version**
  instead of a Keep mine that would leave it refused. **Forget the versions seen** resets a
  library's version floors.
- **App: one list of trusted signers.** **Hosts & settings → Trusted signers** lists every key the
  app counts, for the team library and run reports alike, each with where it counts: trusted from
  a team library (that library only, flagged **No longer published** when it drops the key), or
  **added by you** (pasted allowed_signers lines, every runbook). The two lists of the builds
  before move into it once. The app has one signature verifier (Ed25519, ECDSA P-256/384/521,
  RSA, security keys and passkeys), with the namespace always given: `md-runbook` for runbooks,
  `md-runbook-run` for run summaries. Addresses with a user name, backslashes or blanks are refused, and
  the parsed address is the one stored, read and shown; files over 2 MB are cut off while they
  arrive, a library past 20 MB in all is not read further, a read that stalls gives up after 30
  seconds, and redirects to another server refused (as is an answer that doesn't say where it
  came from). The phones use a library at the address set
  under **Hosts & settings → Team library**, or added with a `mdrunbook://library?url=…` link or its
  QR code (**Share library**). The web container serves the folder without its hidden files and
  without links to other owners' files; the folder is public to anyone who reaches the app. GitHub
  Pages publishes `apps/mobile/public/runbooks/` with a generated index.json.
- **Failure triage:** a failed step's cell and Steps row offer **Explain** and **Suggest a Fix** (the
  assistant proposes a corrected command or a check, added after the step as a proposal to approve),
  and the new `on-failure="Rollback"` option offers the step with that name. The error line under
  the row shows its last lines on hover.
- **VS Code: Run Until Here, Pause Before This Step, Notify Me When It Starts.** Right-click a step
  in the Steps view (or the cell's ⋯). A pause makes Run All stop before the step and ask
  Continue / Stop on the cell; a notification comes when the step starts, once. For the session;
  the file doesn't change. From the VS Code review's feature ideas.
- **Run history and "last ran green":** VS Code keeps a short record of each run (when, who, how
  far, which step failed), on this machine and never in the file. **Show Runs…** (Run ▾) lists
  them, newest first; pick one to open the transcript at that run. The status bar tooltip says
  `Last ran green: 3 days ago (by smojon)` or `Never ran green`. From the VS Code review: a step that
  never ran in a recorded run gets a hint, `This step has never run here.`
- **Tools for VS Code's agent mode** (VS Code 1.95 or later; agent mode needs 1.99):
  `#runbookState` gives the agent each step's state and time, what the run waits for, the
  "Before you run" line, and a failed step's code and last 20 output lines, redacted (secret
  values and typed-in values never). `#proposeRunbookStep` adds a step as a proposed cell, after
  VS Code asks you. It lands like one from **Suggest Next Steps** and doesn't run until you approve
  it. Both refuse while `mdRunbook.ai.provider` is `off`, and `#proposeRunbookStep` also refuses
  while `mdRunbook.approval.enabled` is off. A proposal can now carry a step name (`name=`). From
  the VS Code review.
- **App: the Steps view, as in VS Code, on phones too.** A phone (or a narrow browser window) has a
  **Runbook | Steps** switch at the top, remembered for each runbook; the runbook keeps its rail,
  and a tap on the rail, the run bar's headline or ⋯ More → Show Steps switch to Steps (the
  bottom sheet is gone). While the run waits for you, Steps has a dot; it never switches by
  itself. Steps (and the side panel on a wide screen) has VS Code's header: where the run is, the
  bar, the time left, **Retry step** and **Resume** after a failure, Run all / Stop on a phone,
  and a preflight line whose counts go to the first step that needs them (values open Set
  Inputs). A failed row shows the last line of its error; a long press on a row opens the step's
  actions (with the new **Run Until Here**); a checklist item has a tick box; the step the run
  waits at has the card's answers as buttons (Done / Skip / Stop, Take down / Leave it up, Run /
  Cancel), or **Answer** for a question you type into.
- **Progress by steps while some have no estimate:** the Steps view and the status bar tooltip say
  `2 of 6 steps · at least 5s left` instead of a percentage the estimates can't back, and the bar
  goes by steps then (the app drops the percentage too). From 3 runs on, a learned estimate's
  tooltip says how much they varied (`28s–41s over its last 4 runs`).
- **Transcripts go in a `.md-runbook` folder** next to the runbook
  (`.md-runbook/deploy.runbook.transcript.log`), not beside every runbook. In a Git repository, the
  first one offers to add `.md-runbook/` to `.gitignore` (**Add to .gitignore** / **Not Now** /
  **Don't Ask Again**). An empty `mdRunbook.output.transcriptFolder` keeps them beside the runbook.
  From the VS Code review.
- **The first five minutes:** **Open Sample Runbook** opens a short deploy (six steps, under a
  minute: a parameter, estimates, a confirmation, a step by hand, a smoke test that fails once to
  show Retry and Resume, a teardown) with the Steps view; the old sample is **Open Feature Tour**.
  A Markdown file that looks like a runbook offers **Open as Runbook** once (or **Always for
  \*.runbook.md**). The walkthrough has a "Watch a run" step.
- **Settings:** a **Progress and notifications** group (status bar, follow the run, learned
  estimates, notifications) and a **Reports** group, instead of both inside "Saved output" and
  "Running cells". The README starts with "try it in a minute" and what the run looks like.
- **VS Code: a calmer, clearer Steps view.** A chapter with only one step is one row. Checklist
  items stay under their own heading. Rows are updated in place, so a click, the hover and the
  keyboard focus are no longer lost while a step runs. The row buttons are VS Code icons, beside
  the time instead of over it, and the running step has a spinning icon by its name. After a
  failure the header has **Retry step** and **Resume**, and the failed row shows the last line of
  its error output. Each count of the preflight line is a link (Set Parameters or Set Inputs, Set
  Secret, or the first step that needs it), in plain grey rather than amber. In high contrast the
  bars have an outlined track. The view no longer disappears: with no runbook it offers **Open
  Sample Runbook** and **Open as Runbook**.
- **VS Code: keys for the run.** Ctrl+Alt+R resumes the run, Ctrl+Alt+N goes to the next step,
  Ctrl+Alt+S shows the Steps view, Ctrl+Alt+D marks the selected step done (⌃⌘ on a Mac). In the
  Steps view, on a row: R runs the step, F runs from it, D marks it done, S skipped, U unmarks it,
  Space ticks a checklist item. Screen readers hear the block's estimate in words ("12 seconds of
  20 seconds") instead of the bar's characters, and the status bar's progress without icon
  names. The session and context status bar items have their own names in the status bar menu.
- **VS Code: a run stays on screen when you look away.** With another file in front, the status
  bar keeps a running or waiting runbook, named (`deploy-checkout · Step 2/5 · …`), and a click
  brings it back; the Steps view follows the same runbook. From the VS Code review.
- **VS Code: questions on the cell, not in dialogs.** **Done by hand?** (Done / Skip / Stop) and
  the teardown offer (Take Down / Leave It Up) are buttons on the cell and its Steps row, so the
  window stays free; ticking the box counts as Done. A risky command's question names the step
  and the runbook and shows the command; with another file in front it's asked on the cell too.
- **VS Code: a failed step has its next moves on it:** Retry, Resume from Here, Mark Done and,
  with the assistant on, Explain. Escape on a value prompt no longer fails the step: it stays to
  do (`exit=unanswered`). The "stopped after cell N" message is gone (the status bar says which
  step).
- **Notifications:** a run of one cell that took 30 s or more notifies too
  (`notifications.afterSeconds`); a question's notice closes itself once answered and isn't shown
  when a box or dialog already is; **Don't Show Again**; opt-in system notifications
  (`notifications.system`).
- **Honest time left:** `at least 4 min left · 2 blocks without an estimate` while steps without
  any estimate are to do, and `ends ≈` only while a run is going (VS Code and the app). Learned
  times: run copies learn into their runbook, **Forget Learned Times…**, `estimates.learn`.
- **Estimates that learn.** A block without `estimate=` shows its usual time once it has run:
  the median of its last 5 runs that passed, with a `~` (`est. ~1m15s`), and it counts in the
  time left and the end time, in VS Code and the app. Kept on the machine, never in the file;
  editing the command starts again; a click in VS Code writes it as `estimate=`.
- **App: notifications when a run needs you.** While the app is in the background (or the
  browser tab is hidden), a run that is done, fails or waits for an answer sends a notification
  in the run bar's words, and a tap opens the runbook at that step. The first Run all offers them
  and the system asks only after **Notify me**; **Hosts & Settings → Notifications** turns them on
  or off. A phone stops a backgrounded app within seconds to half a minute, so leaving the app
  mid-run gives a notification that the run is paused rather than a result that won't come.
  Local notifications only (expo-notifications, no push); the iOS and Android apps need a new build.
- **A step without `name=` is called by its heading.** A block that is the only one under a `##`
  (or deeper) heading takes that heading as its step name in the status bar, the Steps view, the
  notifications and the app (`Step 3/6 · Restart the API`), instead of its first command. Blocks
  sharing a heading keep their first line, which tells them apart.
- **App: preflight in the Steps sheet.** As in VS Code, each step still to do says what it will
  need (your confirmation, a secret not stored on this device, an input, an approval), and the
  sheet's header sums it up before a run. The pinned run bar now starts past the rail (its first
  letters were under it), and a step waiting for you shows a pause icon (web drew ❚❚ as one bar).
- **VS Code: preflight in the Steps view.** Before a run, each step still to do says what it will
  need from you (your confirmation, a secret not stored yet, an input or parameter, an approval),
  and the header sums it up: `Before you run: 2 confirmations · 1 secret to set · 1 step by hand`.
- **VS Code: a notification when you look away.** A run of several cells that ends (done, or a
  step failed) or starts waiting for you while its runbook isn't the editor in front says so,
  with a button to go to the step, resume the run or answer (`mdRunbook.notifications.enabled`).
- **"Resume" everywhere, and the assistant can be found when it's off.** The app's button after a
  stop is **▶ Resume**, as VS Code's Resume Run ("Continue" stays for line stepping). In VS Code,
  Assistant ▾ shows **Turn On the Assistant…** while the assistant is off (its other actions stay
  hidden until then): it asks which provider to use, and nothing is sent before you choose.
- **App: menus tidied after a review.** A cell's ⋯ has **Run from Here** (this step and every one
  after it) and, on a proposed cell, **Review Proposal…** first. ⋯ More → Values has **Set
  Inputs**: every `${input:…}` the runbook uses, set before a run. **Clear All Outputs** asks first
  and comes last in Run. Go to Next Step and Go to Next Problem moved to Steps, and the settings
  screen has one name, **Hosts & Settings**, in Help. On a phone the search field no longer opens
  the keyboard when a sheet opens.
- **Menus tidied after a review.** In VS Code: Run ▾ lists Resume Run first again, with Show Steps
  and Go to Next Step together; its runbook-call items show only while a call is selected; the
  toolbar lists show whether a switch (Transcript) is on; Approve / Reject Proposed Cell no longer
  appear in every cell's menu (a proposed cell has them on its status line); the cell menu puts
  Clear Outputs Above / Below last; Copy Cell for AI has the AI icon; a Markdown file's right-click
  menu keeps only Open as Runbook at the top. In the Steps view, a skipped step has its own symbol
  and a step marked by hand can be unmarked.
- **Run All waits at a step done by hand.** An unticked checklist item (`- [ ]`) between two blocks
  is a step too: Run All stops there and asks **Done by hand?** — **Done** ticks it, **Skip** goes
  on without ticking it, **Cancel** stops the run (Resume Run asks again). `manual-steps: continue`
  in the front matter keeps the items as reminders.
- **VS Code: act from the Steps view.** Each step has its own buttons (run this step, run from
  here, mark done or skipped; tick a checklist item); the title bar has Run All or Stop, Resume Run
  (shown only when there is something to resume, also on the toolbar) and Go to Next Step; the
  view's icon shows how many steps are left. **Show Steps** is on the toolbar and in Run ▾, and the
  view opens by itself on the first Run All. The view is called **Steps**, and the ready check's row
  says what it answered (`not up → setup runs`). The share done now moves during a long step.
- **App: the steps by name, and Run all waits at a step done by hand.** Tap the run bar's
  headline, the rail, or ⋯ More → **Show Steps** for a list of every step, the same rows as VS
  Code's Steps view: chapters as headings, each step with its state as a symbol and a
  colour, its number, name and time; tap one to go there. Press and drag along the rail and a
  bubble names the chapter and step under your finger; let go to go there (its touch strip is 44
  px wide, beside the cells). On a tablet or a browser window 900 px or wider the list is a panel
  on the left instead of the rail, and the runbook keeps a readable width. Run all now stops at a
  checklist item that isn't ticked, with a **Done by hand?** card under it: **Done** ticks it,
  **Skip** goes on, **Stop** ends the run (Resume asks again); `manual-steps: continue` in the
  front matter turns that off.
- **Fixes from a design review of the new progress.** The chapter name on the app's rail showed
  as an empty pill on iOS and Android. The app's run bar no longer shows a red Stop and "100% ·
  nothing left" while the run waits for an answer: it says **Waiting for you** in amber and its
  button goes to the question. Neither client says "100%" or "nothing left" while a step is still
  open (a step done by hand has no time): `99% · 1 step left`. The finish time reads `ends ≈ 14:32`
  everywhere. A ready check's `exit 1` no longer prints a red notice in the app (the output line
  says "ready: not up"). The teardown question is plainer in both clients: **Take it down now?**
  with **Take down** / **Leave it up**.
- **Accessibility.** The Runbook Steps view works with the keyboard (Up/Down, Home/End, Enter), has
  tree roles, shows each step's state as a symbol as well as a colour, announces a change of state,
  and stops its pulse with reduced motion. In the app, amber text is darker in the light theme
  (4.5:1 on white), the rail's pulse stops with Reduce Motion, and its ticks name their step.
- **VS Code: the Runbook Steps view** (its own icon in the activity bar): the same rail as the
  app's, with room for names: chapters and steps with their state, name and time, the running
  step's bar, the cells on screen shaded; click a row to go to it.
- **App: a progress rail down the left edge**, always in view: it fills from the top as the run
  goes down the runbook, with a tick per step (green done, red failed, pulsing while it runs), a
  crossbar per chapter and a pale box for the part on screen. Tap a tick to go to its step, a
  crossbar to go to its chapter.
- **Enter is often enough.** A parameter or input asked for opens with the value you used last
  time for that runbook, and says when (`last used yesterday; Enter keeps it`); a parameter never
  given shows its default. Never for secrets or masked inputs. In VS Code and in the app.
- **Progress you can read at a glance, in the same words everywhere.** VS Code's status bar says
  where the run is (`⟳ Step 3/6 · Push image · 1m 40s left`, `✗ Step 4/6 failed` in red,
  `✓ Done · 6/6 · teardown offered`), and its tooltip is a table of the setup, steps and
  teardown with one percentage, the time left and when the run ends (`done ≈ 14:32`), with links
  to the running, failed or next step. The app's run bar says the same in words, and a slim bar
  stays pinned on top while you scroll during a run. The ready check is no longer counted as a
  step, and a teardown not run yet is offered, not a step left to do. The time left counts
  seconds under two minutes, so it moves while you watch.
- **A block's bar that moves.** In VS Code the running block's bar is twice as long and thick
  (`██████░░░░`; it was 10 `#` and `.`), with a warning icon once past its estimate. After a run
  noticeably over its estimate, the block says by how much (`est. 2m30s · took 3m10s (+40s)`),
  and a click sets `estimate=` to what it took. In the app the bar is thicker, `Running · 12s of
  1m` is one line, the output line shows the estimate beside the duration, and `estimate=` is no
  longer repeated in the options line.
- **Run All follows the run** in VS Code: the block about to run is scrolled into view while the
  one before it is still in view (scroll away to stop; `mdRunbook.execution.followRun`).
- **`md-runbook run`: the progress bar fits the terminal** (10 to 30 characters, still ASCII; 20
  in a CI log).
- **App: `exit N` in a cell records exit code N.** A cell that ended with `exit 1` (a ready check,
  `test -f x || exit 1`) showed `error` and "the remote shell ended", and a ready check read it
  wrongly. The app now takes the exit status the server sends when the shell ends, as VS Code's
  session mode does: exit 0 means up, anything else not up, and the output says
  `[md-runbook] the shell ended (exit 1); the next cell starts a new one`. Through
  md-runbook-gate, whose own exit status isn't the cell's, it stays an error. The output line names
  the ready check's answer (`✓ exit 1 · ready: not up`, also in VS Code's CodeLens and the command
  line), an error is never shown with a ✓, and the icon beside a cell in the app follows the
  same rule (a cell that passed its check with exit 1 no longer shows a red icon).
- **A value to type no longer looks like a slow cell.** VS Code's input box opens at the top of
  the window, easy to miss while the cell's spinner and timer ran. Values and confirmations are
  now asked before the cell starts (it shows as queued); while a box is open, the cell's status
  line and the status bar (yellow) say **Waiting for you: parameter NAME**, and the box's title
  names the cell. **Run All** asks for every input and parameter its cells need at the click;
  Escape there cancels the run. In the app, the card asking for values opens under the cell that
  needs them (it was at the top of the runbook), scrolled into view, its first field focused.
- **App: no false "no such runbook" on calls.** A runbook opened from a file showed that error on
  every call until the file it calls was picked; lint now checks a call only once the app can read
  what it calls. The teardown card scrolls into view with its buttons, and the teardown's part of
  the run bar is easier to see (at least 8% wide, a darker outline).
- **App: the line under the run bar fits on one line.** Icons and short times instead of words:
  `0% · ⌚ ~55m · ↑ +19m? · ↓ 2m?` (time left, setup, teardown; `?` = may run). It took up to
  four lines on a phone. A screen reader still reads it in full words.

## 0.22.0

- **Setup and teardown that check whether they are needed** ([#29](https://github.com/smojon/md-runbook/issues/29)).
  A `ready` block is a runbook's ready check (exit 0: already up); `setup` steps are skipped when
  it passes, and a `setup` call to another runbook runs that runbook's check first. `teardown`
  steps are offered at the end, never run unasked: `md-runbook run --teardown` (after success),
  `--teardown=always`; `--from N --setup` resumes and brings the setup back if it is down;
  `--setup-always`, `--no-setup`. The progress and `md-runbook estimate` show the parts
  (`+19m if the setup runs`, `setup ✓ already up`, `teardown 2m, offered`); `--json` gives each
  step its `part` and the run its `setup`. In VS Code and the app, Run All offers the teardown
  (**Take down** / **Not now**, not asked again for that runbook until the window is reloaded or
  the app restarts); the app's run bar shows the setup, the runbook and the teardown as three
  segments, and VS Code's status bar tooltip a line for each. Lint checks the order. See
  [setup and teardown](docs/features/setup-teardown.md).
- **Calls in the app, as on the other clients.** A signed runbook's call must be as signed, its
  values must match their patterns, and the runbook called must be signed and unchanged.
  Cycles and calls more than 3 deep are refused. A different `kube-context:` is refused, and
  none inherits the caller's. The call's ⋯ has **Run with a Fresh Copy** and **Open the Copy It
  Ran**. Export Report shows the copy's steps under the call. Lint and the estimates read the
  runbooks calls name (downloaded ahead for a runbook opened from a web address).
- **md-runbook-gate logs which call loaded a runbook** (protocol 2: the `called` request; the
  `load` event gets `called-by` and `call`), and `md-runbook audit` shows it (`called by
  ops/upgrade v4 (call 1)`). The app sends it only to gates that speak protocol 2.
- **Runbook calls in the app.** ▷ on a call (or Run all reaching it) makes the copy, gives it the
  parameters passed and opens it to run (the call's sections); the result comes back to the call,
  and Continue goes on after it. A runbook opened from a web address gets the runbook a call names
  next to it (same site, same repository); one opened from a file asks to pick it once. Before,
  Run all passed over a call without a word and ran the steps after it as if it had run.

## 0.21.0

- **Signed runbook calls; `md-runbook run --allowed-signers FILE`.** A call is signed as written
  (its placeholders need patterns, `src=` relative, no secrets); the runbook it calls is signed
  on its own. `run --allowed-signers` runs a signed runbook only as signed, as md-runbook-gate
  would: before anything runs it checks the signature against `FILE`, that nothing changed since
  signing, that every block that would run is signed, each parameter against its pattern, and
  for each call that its runbook is in the repository, signed, and passes the same checks with
  the values passed. `verify` checks a runbook's calls too. Servers with md-runbook-gate don't
  run calls yet.

- **Manual steps on the command line.** `md-runbook run` lists the unticked task-list items
  (`- [ ] Check the canary`) of the part it runs, where they are (`☐ manual, not ticked ·
  file:line · …`), and in `--json` (`manual`), the JUnit report (skipped "Manual" cases) and the
  job summary; they get no step number. A `--section` (or a call's `section=`) of manual steps only
  is no longer "selects no step". **A runbook that keeps evidence (`evidence: true`, `incident:`)
  fails when one is not ticked**, so a check nobody did is never passed over; other runs only list
  them. Lint warns about a call's `section=` of manual steps only. Found on asni-ci.

- **Fixed: a comment on a `params:` line.** `- ENV  # asked` didn't declare ENV at all, and
  `- A: 1  # x` gave A the default `1  # x` (comment included), although the syntax reference
  shows that form. Both now read as in the rest of the front matter: the comment is dropped, a
  quoted value keeps its `#`, and `- B: ""` stays an empty default.

- **Run another runbook as one step: ```` ```runbook ```` blocks.** `src=` names the runbook
  (relative to this file, `${param:}` and `${out:}` allowed), the block's lines pass its
  parameters (`ENV=${param:ENV}`, secrets redacted and never written), `section=` runs only part
  of it. It runs as a dated copy next to it, in a session of its own, with only what is passed;
  the call fails when one of its steps fails, and its output records the runbook, the copy, the
  steps and the copy's SHA-256. A failed call run again continues in the same copy
  (`--fresh-copy` starts a new one). The caller's `evidence:`, `drill:`, `incident:` and `rto:`
  carry over to the copy; a different `kube-context:` is refused, none inherits the caller's.
  Cycles and calls more than 3 deep are refused before anything runs. `md-runbook run` follows
  calls (steps 5.1, 5.2, … in the log, `--json`, JUnit and the job summary; `--copy-folder`);
  Export Report and `--report` show the copy's steps under the call (5.1, 5.2, …), link the
  copy and flag one changed after the run (its SHA-256); lint checks a call against the file it names (unknown or missing parameters, sections, a
  missing file); `md-runbook estimate` counts a call as what it runs. In VS Code the copy opens beside the runbook
  and runs there (its confirmations and inputs as usual; the parameters passed are never asked),
  the call cell lists each step as it finishes, and its status bar has **Open** (the copy) and
  **Fresh copy**. Docs: [docs/features/calls.md](docs/features/calls.md).

## 0.20.0

- **How long it takes: `estimate=`.** Annotate a block with the time a real run took
  (`estimate=2m30s`, the durations `every=` takes, or plain seconds; it never changes how the
  block runs). The extension shows it on the block's status line and, while the block runs, a
  bar against it that fills at the estimate and then says how much over it is
  (`[##########] +1m20s over 2m30s`); its status bar item adds about how long is left, counted
  by the estimates (the bar, the share done and the blocks without an estimate in its tooltip).
  The app shows the estimate beside the cell's options, a bar on the running cell, and the
  runbook's share done and time left at the top. `md-runbook run` puts it on the step line,
  warns when a step took more than twice its estimate and over a minute more (exit codes
  unchanged), shows the run's progress after each step in a terminal (never in a CI log), and
  writes `estimateSeconds` to `--json`, an `estimate` property to the JUnit report and the
  estimate beside the duration in the HTML report and the job summary. `md-runbook estimate
  file.md` sums the estimates per `#`/`##` section and in all. Lint reports an invalid value;
  `every=` now also takes `1m30s`.
- **The title of a runbook with a commented front matter.** `md-runbook qr`, `md-runbook link`
  and a link opened in VS Code took a `# comment` in the YAML front matter for the runbook's
  title; they now take its first `#` heading, as the app does.
- **The app checks runbooks too.** The md-runbook app runs the same checks as `md-runbook lint`
  and the extension's problem markers. Each code cell lists its problems under it, with a mark
  beside the line concerned, and the top of the runbook counts them ("1 error, 2 warnings"); tap
  the count for the full list, front matter included. **⋯ More → Go to Next Problem** goes
  through them. A misspelled option gets a **Change "retires" to "retry"** button, as the
  extension's Quick Fix.

## 0.19.3

- **npm without a token.** The release workflow publishes the command line to npm through npm's
  trusted publishing: npm accepts a publish only from this repository's release workflow, and no
  npm token is stored anywhere. The VS Code extension and the command line are unchanged.

## 0.19.2

- **The command line is on npm.** `npx md-runbook run runbook.md` or `npm install -g md-runbook`
  now works on any machine or CI system with Node.js 20 or newer, with no clone and no download
  from a GitHub release. Pin a version with `npx md-runbook@0.19.2 …`. The package is published
  by the release workflow with provenance, so npm shows the workflow run that built it. The
  VS Code extension is unchanged.

## 0.19.1

- Reached Open VSX only: its npm publish failed, so it has no GitHub release. Same extension as
  0.19.0.

## 0.19.0

- **A dev container feature:** `"ghcr.io/smojon/md-runbook/md-runbook:1": {}` in a
  `devcontainer.json` installs the command line and the VS Code extension in a dev container or a
  GitHub Codespace ([docs](docs/features/devcontainer.md)). Each GitHub release now also carries
  the command line as `md-runbook-cli.tgz`, the npm package as a file, which the feature installs.
- **Runbook links open in VS Code.** The link in a pager alert only opened the phone app, so on a
  laptop clicking it did nothing. Now `vscode://smojon.md-runbook/open?…`, with the same fields as
  the app's link, opens the runbook in VS Code:
  - your workspace's copy, if a clone of the repository is open and its file is the version the
    link pins (if it differs, you choose which to open);
  - otherwise a downloaded copy, which the same link opens again with its runs.

  The pin and the signature are checked as in the app, and the link's parameters are filled in.
  Nothing runs until you run it. `md-runbook link --vscode` prints such links, and the
  [on-call page](docs/features/on-call.md#on-a-laptop-vs-code) shows them next to the app's in
  Alertmanager and PagerDuty.
- **"Did you mean" for misspelled cell options, with a Quick Fix.** A misspelled option was only
  reported as unknown. Now the warning suggests the option it was probably meant to be:
  `unknown cell option "retires" (ignored): did you mean "retry"?`. A suggestion is made for
  one or two letters off, letters swapped, or an option's plural (`retries`, `timeouts`). In
  VS Code, the light bulb (or Ctrl+.) offers **Change "retires" to "retry"**, which renames the
  option on the fence and keeps its value. This works in the runbook view and in the Markdown
  editor. `md-runbook lint` prints the suggestion too.
- **Terminal mode off: an offer to turn it on.** A cell marked `terminal` that ran while terminal
  mode was off showed a green tick with empty answers, and the note explaining why ran off the
  edge of the output. Now the note is two short lines. Once per session, a notification offers
  **Turn On and Run Again**: it sets `"mdRunbook.terminal.mode": "perCell"` in your user settings
  and runs the cell again in a terminal.

## 0.18.1

- **Fix: terminal mode could lose a cell's output on a busy machine.** The cell ran in the
  terminal, and you could see it there, but nothing reached the cell's output, so its checks and
  captures saw nothing either. A cell waiting at a prompt also showed nothing above it. Cause:
  VS Code matches the command it sees start to the one md-runbook sent by its text, and on a busy
  machine the long command line could come back slightly different. VS Code then gave the output
  to a second execution that md-runbook didn't read. md-runbook now reads whichever execution
  starts in the terminal. With the CPU busy, 4 of 10 test runs lost the output before and none of
  10 after.

## 0.18.0

- **`${out:NAME}`, `${param:NAME}` and `${input:NAME}` in `expect=` and `expect-not=`.** A check
  compared the output with the literal text `${out:GREETING}`; it now compares with the value, as
  the cell's code gets it: `expect="${out:BEFORE}"` after a change, `expect="${param:STATEMENTS}"`
  for the value the operator chose. In a regular expression the value is matched as literal text
  (`expect=/^max=${param:N}$/m`). The values are asked or looked up before the cell runs, like the
  code's, and the failure says what was compared (`the output does not contain "512"`). A secret
  can't be used in a check (its text is shown when it fails): `${secret:NAME}` there is an error,
  and so is a value captured with `capture-secret=`. VS Code, the command line and the app; lint
  checks these references too. Issue #21.
- **The Kubernetes context from a parameter**: `kube-context: ${param:CONTEXT}` in the front
  matter (or `kube-context=${param:CONTEXT}` on a cell), with `pin` and the check working as for a
  name written out. One runbook then serves a lab and production: with `CONTEXT: rancher-desktop`
  as the parameter's default, a run without parameters can only touch the lab, and
  `--param CONTEXT=prod-eu` (or the value typed in VS Code or the app) runs it on production,
  without `--context` on every kubectl and helm call. The value must be a context name, or nothing
  runs. The command line's step line names it, and the output marker records it as
  `kube-context=`. Signing a cell with `kube-context=${param:NAME}` needs a `--pattern` for NAME,
  and the app checks the value against it, so a signed runbook can't be pointed at a cluster its
  signer did not allow. Issue #22.
- **Fix:** `md-runbook verify` (and signing in VS Code) could crash with `write EPIPE` when
  ssh-keygen finished before md-runbook had written its input. That error is now ignored, and the
  result comes from ssh-keygen's exit code and message, as before.

## 0.17.0

- **`env:` in the front matter**: variables for every cell run in VS Code or from the command
  line, one `NAME: value` per indented line (`NO_PROXY: localhost,127.0.0.1`, `PAGER: cat`); a
  cell's own `env.NAME=` wins. The md-runbook app doesn't use it: the front matter isn't signed,
  so a signed cell on a host never gets variables someone added beside it. The linter warns about
  names that change what every command runs (`PATH`, `BASH_ENV`, `LD_*`, ...), lines it ignores, a
  name set twice, a `host=` cell, and `env:` in a signed runbook.
- **A passkey as the web app's SSH key.** In the web app, **Hosts & settings → Use a passkey**
  makes the key a passkey for the site (Windows Hello, Touch ID, a phone, a security key): the
  private key never reaches the browser's storage or the app, and each SSH login and each
  signature asks for the person. Stock OpenSSH accepts it with no server change: the key is an
  `sk-ecdsa-sha2-nistp256@openssh.com` key whose application is the site, signed in OpenSSH's
  `webauthn-sk-ecdsa-sha2-nistp256@openssh.com` format; the line the app shows starts with
  `verify-required`. Runbooks signed with it verify with `ssh-keygen -Y verify`, so
  md-runbook-gate accepts them. Off by default; turning it on or off makes a new key.
- **The app retries `retry=` cells.** A cell with `retry=10 every=30s expect=…` ran once in the
  app and showed *check failed*; it now runs up to N times until it passes, `every=` apart, as
  VS Code and the command line do: the running cell says `attempt 2/10`, or which attempt failed
  and when the next starts (with the reason in the output), Stop ends the wait, and only the last
  attempt's output is kept, with `attempts=`. A signed cell goes to md-runbook-gate again for each
  attempt, as the same signed cell. Line runs run once, as in VS Code. Found running an SOP from
  an alert in the web app.
- **The app asks before a risky cell.** A cell with a risky command (VS Code's default patterns:
  `delete`, `apply`, `rollout restart`, `rm -rf`, `helm upgrade`, …) or the `confirm` option ran
  straight away in the app. It now shows a card under the cell, with the risky match, the account
  it runs as and how often `retry=` may run it, and runs only after **Run**; Run All waits there,
  and **Cancel** stops it. Run on a Group asks once for the group. A runbook's `no-confirm` counts
  only after **Hosts & settings → Asking before a cell runs** allows it (off by default, like
  VS Code's `mdRunbook.execution.allowNoConfirmOption`).
- **A runbook's title in the app is its first heading**, not a `# …` comment in its YAML front
  matter or a `#` line in a code block: an SOP whose front matter starts with
  `# Every command runs against this cluster…` was listed, opened and shared under that comment.
  The run report skips `#` lines in code blocks too.
- **The same runbook link opens the same copy.** Each click on an alert mail's link added another
  copy of the runbook to the app's list. The app now remembers which link opened a copy: the same
  link opens it again with the link's host and values, as long as the runbook at that address is
  unchanged (a changed runbook is a new copy). **Start Incident** still makes a copy per incident.
- **Relay tokens a browser can send.** The relay's README and `compose.example.yml` made the
  token with `openssl rand -base64 32`, which always ends in `=`: the browser sends the token as a
  WebSocket subprotocol (`token.<token>`), which allows no `=` or `/`, so the web app could never
  connect (`new WebSocket` throws a SyntaxError). The docs now say `openssl rand -hex 32`, the
  relay refuses to start with a token a browser can't send and says how to make one, and the app
  refuses to save such a token, saying why.
- **The Release workflow says when it skips npm.** Without the `NPM_TOKEN` secret the command
  line is not published to npm (`npx md-runbook` answers 404); the run now shows a warning that
  says so, instead of a quietly skipped step.

## 0.16.0

- **The web app and the relay as container images.** Each release now also publishes
  `ghcr.io/smojon/md-runbook-web` (the web export behind nginx, to host the app on your own
  domain; [apps/web](apps/web/README.md)) and `ghcr.io/smojon/md-runbook-relay`, next to the ops
  host and the probe. A new workflow builds the web image on every change to the app and checks
  that it serves the app, its routes and its bundles.

## 0.15.1

- **No stray `m` before red stderr lines on Windows.** A Windows program ends its lines with
  `\r\n`, and the colour reset went between the `\r` and the `\n`. VS Code rewrites a line at a
  `\r` character by character (as Jupyter does), so the reset overwrote the colour's first four
  characters and left the fifth, `m`, at the start of every stderr line, a Python traceback's for
  example. The reset now comes before the `\r`, and a line rewritten with `\r` is coloured as a
  terminal shows it.

## 0.15.0

- **Line buttons on the cell's status line.** The run buttons of the line the cursor is on
  (**Run line**, **Run lines 1-N**, **Run lines N-end**, **Step from here**) are also under the
  cell, and stay while the cell is selected: click in the line, then on the button. The hover
  was hard to reach on a cell's first lines, where VS Code draws it above the cell and closes it
  as soon as the mouse leaves the cell's text. Reported by the user.

## 0.14.1

- **The hover's line buttons work on Windows.** Clicking **Run line**, **Run lines …**, **Step from
  here**, **Check**, **Breakpoint** or **Copy** said *open a runbook and pick a code cell first*:
  VS Code decodes a command link's arguments twice, so the cell's address arrived with `c:` for
  `c%3A` and was not found. The ▶ ☐ buttons (`lines.buttons: inline`), the right-click menu and
  Ctrl+Alt+Enter were not affected.

## 0.14.0

- **The transcript in the menus.** **Run ▾ › Open Transcript** opens `<runbook>.transcript.log`
  beside the runbook (it grows as later runs append); **Run ▾ › Transcript** turns it off or on
  (a check mark while on; the user setting `mdRunbook.output.transcript`). Before, only someone
  who knew the setting's name could turn it off.
- **Help ▾ › Settings…** opens md-runbook's settings, so every one can be found from a menu.
- **`md-runbook run --section` refuses a section that matches the runbook's title**: the title
  holds every step, so `--section "6."` for `## 6. The scheduled check` also matched
  `# 6. Are the backends up?` and ran the whole runbook. The message names the heading meant and
  how to say it (`--section "6. The"`).

## 0.13.0

- **Saved output is what the terminal showed.** Carriage returns overwrite from the first
  column (`abcdef
XY` was saved as `XY`, a terminal shows `XYcdef`), backspaces and the
  erase-line, cursor up/down/forward/back, column and save/restore sequences are applied, so a
  spinner or a multi-line progress display is saved as it ended instead of every frame; other
  control characters, which showed as odd symbols, are dropped. Clearing the screen keeps what
  was printed. Colours are stripped as before.
- **Python's `é` and `✓` on Windows.** A Python script's output was saved as `�` (and a `✓`
  stopped it with `UnicodeEncodeError`): Python writes to a pipe in the ANSI code page
  (cp1252). Cells on Windows now get `PYTHONIOENCODING=utf-8`, unless `PYTHONIOENCODING` or
  `PYTHONUTF8` is already set. Reported by a tester as a difference between the terminal and
  the runbook.

- **Transcript** ([details](docs/features/history.md#transcript)): every run of a cell is
  appended to `<runbook>.transcript.log` next to the runbook as its output arrives: a header
  (time, step, heading, name), the script, each output line (`| ` stdout, `! ` stderr), each
  retry, and a footer (exit, duration, check, attempt), plus checklist items ticked by clicking.
  It is on disk even if the runbook is never saved, so a run can be followed with `tail -f` and
  read afterwards. Redacted like a saved runbook; a `capture-secret=` cell is written when it
  has finished. Past 10 MB the file starts again (one older kept as `.1`). **On by default**, the
  one default that is not the most secure choice: add `*.transcript.log` to `.gitignore`, or
  turn it off with `mdRunbook.output.transcript`. `transcriptFolder` and `transcriptExtension`
  say where and how it is named (user settings only). The command line writes one with
  `--transcript FILE`.

## 0.12.0

- **Command line: part of a runbook** ([details](docs/features/cli.md#part-of-a-runbook)).
  `md-runbook run --from 6` resumes a long run at the step it stopped at, numbered as the run's
  `▶ Step N` lines number them (the same with or without a range), `--to 9` ends earlier, and
  `--section "3."` (repeatable) runs only the steps under the headings that start with that
  text, sub-headings included. The steps left out are skipped and keep their outputs. A range
  outside the runbook, a section that matches no heading, or a selected step whose
  `${out:NAME}` is captured only by a step left out stops the run before it starts (exit code 2).
- **Command line: cells that need `--yes` are found before the first step.** Without `--yes`, a
  run that has a risky command or a `confirm` block it would run (for this OS, in the selected
  steps) now stops before anything runs, with exit code 2 and a list of those steps and why,
  instead of after the steps before them. With `--keep-going` they are declined where they are,
  as before. Nothing more runs without `--yes` than before.
- **Pin the Kubernetes context** ([details](docs/features/kubernetes.md#check-or-pin)):
  `kube-context-mode: pin` in the front matter makes the runbook's and its cells' `kube-context`
  the context their cells run against, instead of only checking it. Each cell run in VS Code or
  on the command line (isolated or in a session) gets a `KUBECONFIG` whose first file only says
  `current-context: NAME`, followed by your own kubeconfig, so kubectl, helm and k9s use that
  context without `--context` flags and without changing your default context. No credential is
  copied, a `use-context` in a cell only changes the temporary file, and the file is removed when
  the run ends or the runbook closes. Before each cell md-runbook checks that your kubeconfig has
  the context. Cells on an SSH host (`host=`, the app) are still only checked, and lint warns.
  The user setting `mdRunbook.execution.kubeContextPin` turns pinning off.
- **`git-bash-path-conversion: off`** in the front matter: on Windows, Git Bash no longer rewrites
  arguments that look like POSIX paths (`kubectl exec pod -- cat /opt/x` reaching kubectl as
  `C:/Program Files/Git/opt/x`) in the runbook's bash cells. It sets `MSYS_NO_PATHCONV=1` and
  `MSYS2_ARG_CONV_EXCL=*`; other shells and systems are unchanged.
- Lint knows both front matter keys and reports values it ignores.
- **md-runbook-probe** ([guide](docs/features/kubernetes.md#is-everything-up-endpoint-and-certificate-checks)):
  - **Behaviour change: `--ca FILE` now adds to the system's CAs** instead of replacing them, so
    a cluster's CA and public endpoints are trusted in the same run (before, public endpoints
    failed with *certificate not trusted: unable to get local issuer certificate*). `--ca-only
    FILE` is the old behaviour: only that CA is trusted.
  - **`--format json`** (one object per target and line: target, ok, address, reachable,
    tcp_ms, tls, trusted, not_after, days_left, subject, issuer, detail, labels) and **`--format
    prometheus`** (`md_runbook_probe_ok`, `md_runbook_probe_reachable`,
    `md_runbook_probe_certificate_expiry_timestamp_seconds`,
    `md_runbook_probe_last_run_timestamp_seconds`, labelled `target="host:port"`). The text
    lines stay as they were. **Labels:** `--label NAME=VALUE` adds a label to every metric and
    JSON object, and `NAME=VALUE` words after a target label that target only (on stdin: the
    targets on that line), over a `--label` of the same name, e.g. `tls://idm-web:8989
    component=proxy`. So one scrape tells components apart; the same endpoint with other labels
    is another series.
  - **`tls://host:port` and `tcp://host:port` targets** check TLS on any port, or never, per
    target.
  - **Audit outside the gate.** Where no gate runs the probe (no `/etc/md-runbook/gate.conf`,
    e.g. `kubectl exec` into a Pod), `MD_RUNBOOK_PROBE_LOG` names where its events go: a file,
    `stderr` or `syslog`; in a container `/proc/1/fd/1` is its log. Where the gate runs it,
    `gate.conf` alone decides, as before. A destination it can't write is reported once on
    stderr instead of being skipped silently.
- **The probe image** `ghcr.io/smojon/md-runbook-probe` ([apps/probe](apps/probe/README.md)):
  md-runbook-probe alone, without sshd, the gate or kubectl, non-root, published with each
  release next to the ops host image. Its example manifest runs the probe as a Pod next to your
  services, publishing the checks as Prometheus metrics, without a service account token and
  with a read-only root filesystem.

## 0.11.0

- **Kubernetes** ([guide](docs/features/kubernetes.md)):
  - **Wrong-cluster guard.** `kube-context: prod-eu` in the front matter, or `kube-context=` on
    a cell, means a cell runs only while `kubectl config current-context` is that context. The
    check runs where the cell runs, before each cell: in VS Code, on the command line, and in
    the app over SSH. md-runbook-gate answers the check (its new `context` request) also where
    only signed runbooks run.
  - **The ops host** ([apps/ops](apps/ops/README.md)). An SSH server whose only command is
    md-runbook-gate, with kubectl, as a container image. Run it inside a cluster (a manifest
    with its own service account and a restricted ClusterRole, Pod Security `restricted`) or
    next to the relay (`docker compose --profile ops`). The app reaches your clusters through
    it, and no cluster credential is ever on a phone.
  - **md-runbook-probe** on the ops host checks, from inside the cluster, that each endpoint
    resolves, accepts a TCP connection and has a TLS certificate that is trusted, is for that
    name and doesn't expire within 14 days. It accepts only host names, addresses and URLs as
    targets. Every check is a `probe` event in the gate's log, tied to the signed run that made
    it, and `md-runbook audit` lists these events. Export Report and the JSON export show a
    record's checks under **Endpoint checks**.
  - An example runbook: [examples/kubernetes.runbook.md](examples/kubernetes.runbook.md).
- **Incident records for audits and postmortems:** **Start Incident** (Run ▾, and ⋯ More in the
  app) makes a dated copy with `incident:` and `severity:` in its front matter and a first note,
  *detected*. Such a runbook (also `evidence: true`, or the setting
  `mdRunbook.output.recordRunner`) records on every run who ran it (`by=`) and where (`on=`), and
  keeps every attempt. **Add Note** records a decision or a milestone (*detected*, *mitigated*,
  *resolved*) with the time and your name. Export Report (HTML, PDF, the command line's
  `--report`/`--pdf`, the app) then starts with the incident record: start, end, time to
  mitigate and to resolve, the `rto:` target met or missed, failed runs, people and machines,
  and a timeline of every run, attempt, mark and note in time order; printed, every page shows
  the incident and a page number. The command line's `--json` carries the same record.
- **Hosts for teams and providers (app)** ([details](docs/app.md#hosts-and-the-apps-key)): host
  groups with a filter, **Run on a Group…** (one cell on every host of a group, a section per host),
  **Share hosts** as a file or QR code and **Import…** (never a private key; the sender's host keys
  only if you trust them), and **Install my key…** (one password login adds the app's key).
- **Drills and training** ([details](docs/features/drills.md)): **Start Incident** can start a
  drill (`drill: true`; the report says *Drill record* and measures it against `rto:`), and in
  the app **Practice on a Host…** (or `practice: NAME`) runs every cell on a practice server,
  whatever `host=` says; nothing runs if that host is missing.
- **`md-runbook audit`** ([for auditors](docs/features/for-auditors.md)): what servers with
  md-runbook-gate ran, from their logs: every run with the key, account, client, runbook,
  signer, parameters, exit code and duration, and the findings (refusals, unsigned code, stopped
  runs), as HTML, PDF or JSON; `--record` matches a saved run record against the log.
- **Request Co-signature** (Share ▾, ⋯ More → Share in the app): a message with a link that opens
  the signed runbook on Co-sign Runbook in the reviewer's app (VS Code links the pushed file,
  pinned; the app puts the runbook in the link); `md-runbook link --cosign` prints one.
- **Sign Run Record** (Share ▾, ⋯ More in the app, `md-runbook sign --record`): vouch for the
  record of an incident or a drill as it happened, outputs and notes included; a second person
  co-signs it. Export Report shows who signed and whether the record changed since, and
  `md-runbook verify --allowed-signers` checks each signature.
- **Export Run Record (JSON)** (Share ▾, ⋯ More → Share in the app): the timeline, its summary and
  the record's signature as `<name>.record.json`, redacted as the report is, for audit and ticket
  tools.

- **Runbook links:** one link format for Open in the App, QR codes, pager alerts and co-sign
  requests ([details](docs/switching.md#runbook-links)): `sha256=` pins the content (the app
  refuses any other text), `host=` picks a host the app has, `p.NAME=` fills a parameter,
  `action=cosign` opens on Co-sign Runbook, and `rb=` carries a small runbook in the link itself
  (no network needed). Nothing runs from a link. The app shows whether what it opened is signed,
  pinned or neither; **Hosts & settings → Links** can refuse runbooks that aren't signed. **Open in
  the App** now pins the pushed file.
- **`md-runbook link`** prints a runbook link for a pager alert ([on call](docs/features/on-call.md):
  Alertmanager, PagerDuty and Opsgenie examples).
- **QR codes** ([details](docs/switching.md#qr-codes)): **Share ▾ → Make QR Code** writes
  `<name>.qr.svg` for the pushed file (pinned) or the runbook itself (no network needed), with an
  optional host and parameter values; `md-runbook qr --labels hosts.csv` prints a label sheet
  with one code per machine (HTML or PDF). In the app, **Scan a code** on the start screen opens
  a code like a link, and **⋯ More → Share → Show QR Code** shows a code for another phone.

- **The app's own icon and a new look:** the app and the web app's favicon use the extension's
  icon (Android's adaptive and themed icons included). The start screen has the icon in its
  header, **Hosts & settings** as the gear at the top right, **Open a runbook…** and **Open a
  link…** side by side (they no longer run off a narrow phone), and the runbooks as a card with
  each one's file. Hosts & settings shows the hosts as a card ending with **Add a host**, and
  each setting in its own card. The "Core OK" line is gone: the app only says something when its
  self-check fails. An **App APK** workflow builds an arm64 APK to install on an Android phone
  by hand.
- **Terminal mode shows what runs.** Before a cell runs in a terminal, its commands appear there
  as typed at a prompt (`$ `, `PS> `), so whoever watches the terminal sees the cell's commands,
  not only the line that starts its script. They show as written, `${secret:…}` references
  included, never a value, and they are not part of the cell's output, its checks or the saved
  file. Useful for teaching: `terminal.mode: always` runs every cell visibly.

## 0.10.0

- **The front matter isn't drawn in the notebook:** a runbook's YAML front matter showed as a
  `params: • …` list above its title; now the notebook hides it, as VS Code's Markdown preview and
  the app do (editing the first cell still shows it). The README GIF shows the notebook that way.
- **Signing in the app:** **Sign Runbook** and **Co-sign Runbook** (⋯ More) sign with the app's
  own key, inside the phone's Secure Enclave or Android Keystore, in the same OpenSSH format as
  VS Code and the command line, so md-runbook-gate checks them the same way: a reviewer can
  co-sign from a phone. A card asks what VS Code asks (name and scopes the first time, days of
  validity, missing patterns). **Hosts & settings → Signing runbooks** holds your name for
  signatures and the key's line for the servers' `allowed_signers`, with Copy.
- **A runbook can choose its shell:** front matter `shell: zsh` or `shell: sh` runs its `sh`/`bash`
  cells in zsh or POSIX sh, `shell: pwsh` its PowerShell cells in PowerShell 7 only, and
  `shell: windows-powershell` in Windows PowerShell 5.1 even when 7 is installed (`shell: zsh,
  windows-powershell` for both). Only names of installed shells, never a path. In VS Code, the
  command line and the app (which starts that shell on the server); in sessions and terminal
  mode too. A missing shell is an error on the cell. With `shell: zsh`, an assistant's proposal is
  never approved by the allowlist alone, and earlier approvals no longer count (in the app, a
  proposal approved as bash also doesn't run where the server's login profile starts zsh); Sign Runbook
  refuses a Unix shell other than bash (servers run signed runbooks in bash). Lint warns about
  names it ignores.
- **App look and feel, from a screen-by-screen check:** iOS-style toggles on every platform;
  sheets with a grabber, rounded corners, and a raised colour and stronger dim in dark mode; a
  focused field's border in the accent colour on the web (no thick black ring); placeholders
  lighter than typed values; output lines no longer wrap (tables and JSON keep their shape,
  wide output scrolls sideways); why a cell can't run on its own line under the cell; the
  front matter no longer drawn as a list (its values are in the Parameters card); the browser's
  relay notice is a quiet line with a link to set it up; a runbook or link opened directly has
  a back arrow; the link screen has a title and a way back after an error; Hosts is now
  **Hosts & settings**.
- **Cloud console views:** JSON from the AWS or Google Cloud CLI gets a table of its resources
  under the output, each with a link to it in the console: EC2 instances, EKS clusters,
  Compute Engine instances, GKE clusters, Cloud Run services (recognized by the JSON's shape).
  Display only; setting `mdRunbook.output.cloudViews` (on), and in the app under Hosts & settings.
- **Two signers for signed runbooks (four eyes):** a reviewer adds a signature to the signed
  manifest with **Co-sign Runbook** or `md-runbook sign --cosign`, unchanged; md-runbook-gate with
  `signers = 2` (or `--signers=2` on a key) runs only runbooks signed by two distinct trusted
  signers. `verify --allowed-signers` checks every signature; the app shows all signers.
- **Version floors:** `floors = FILE` in gate.conf (`ops/restart-api 7`) refuses older versions
  of a runbook at once, instead of listing each one's hash in `revoked`.
- **Terminal mode for `cmd` cells:** they run from a PowerShell terminal (cmd.exe has no shell
  integration), each in a `cmd.exe` of its own, so prompts like `set /p`, `pause` or `choice` can
  be answered there; `terminal.mode: always` now includes them.
- **Signed runbooks can use `${input:NAME}` and `${out:NAME}`**, each with a pattern like a
  parameter: the app sends the typed or captured value to md-runbook-gate, which checks it
  against the signed pattern. Sign Runbook asks for the missing patterns. Secrets
  (`${secret:}`, `${input:NAME:secret}`, `capture-secret=` values) still can't be signed: the
  gate logs the values it gets.
- **stderr shows in VS Code.** What a cell wrote to stderr was saved but never shown: VS Code
  draws one item of each output, and the stderr items sat next to stdout ones. Now each stretch
  of one stream is an output of its own, in order.
- **Coloured output, in VS Code and the app:** stderr in red, also when a runbook is opened again
  (the output block's new `stderr=` attribute lists those lines), and log levels in the colours
  log viewers use (Grafana's levels, VS Code's log rules, syslog, Nevis, klog): `FATAL` purple,
  `ERROR`/`FAILED` red, `WARN` yellow, `INFO`/`NOTICE` blue, `DEBUG` grey, `TRACE` light blue,
  `OK`/`PASSED`/`SUCCESS` green. A program's own ANSI colours win; the file keeps plain text.
  New settings `mdRunbook.output.colorLevels`, `stderrInRed` (both on) and `forceColor` (off:
  asks programs for colours with `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`); the app has the same.
- **The app runs runbooks on Windows servers** (OpenSSH Server): `pwsh`, `powershell` and `cmd`
  cells, with nothing to set up. The app finds Windows PowerShell there by itself; PowerShell
  cells share one session (variables, functions, the folder), `cmd` cells each run in a
  `cmd.exe` of their own, as in VS Code. `os=` blocks follow the server, and Hosts shows what
  each server runs.

Security fixes from a review of the assistant, signed runbooks and md-runbook-gate:

- **An AI answer can no longer add a runnable cell.** Summarize Incident and Explain Output →
  Insert as Note put the model's text into the runbook; a ```` ```bash ```` block in it (for
  example from a prompt injection in a server's output) became an ordinary cell that ran without
  approval. Code in AI text is now kept as a `text` block. (Extension and app.)
- **The signer's name is no longer presented as checked.** It is written in the file next to the
  signature, and nothing checked it outside a gate: `md-runbook verify` now says `signed by X (as
  the file says)` and `signature: NOT checked` without `--allowed-signers`, and the app shows the
  signer a gate accepted once a block ran through it. A signer name can't end the HTML comment.
- **Line runs of signed blocks split like bash.** A here-doc whose delimiter has quotes
  (`<<E"O"F`) or a function whose body starts on the next line was split into wrong commands, so
  Step through could run here-doc text as a command. Signing now also checks each command with
  `bash -n` where bash is installed.
- **md-runbook-gate:** a client could replace a queued command by reusing a request id (running a
  later command before an earlier one); the client's locale could change what a parameter pattern
  matches; one runbook's parameters stayed set for the next; `PATH`, `IFS`, `BASH_ENV`, `LD_*`
  and similar names are refused as parameters and `env.*`; the revoked list tolerates CRLF, upper
  case and a `sha256:` prefix.
- **Signing** refuses those names too, patterns with JavaScript-only syntax (`\d`, `(?…)`, lazy
  `*?`), `${param:X:…}`, and impossible dates. `verify --allowed-signers` accepts a signer line
  with several principals.
- **Deleted and reordered signed blocks are reported.** Blocks match their signature by content,
  so removing a backup step or swapping two `cd` blocks showed "0 changed". Lint, the editor,
  `verify` (which now fails) and the app name the missing blocks and the moved ones.
- **Signing refuses blocks GitHub doesn't show as code:** a bash block inside an HTML comment, or
  fences indented 4 spaces or more, which a reviewer of the rendered pull request would miss.
- **The app doesn't take a signed block's parameter values from the front matter**, which isn't
  signed: they are typed on the runbook.
- The signature block is the last one outside code blocks (an example in a code block isn't
  read as the signature); a repeated command (two `sleep 5`) runs as the right signed step.
- **The app gives each runbook its own shell on a host.** One shell per host was shared by every
  runbook, so a cell of one runbook could print another's secrets or redefine the commands the
  next cells run with. A secret given to an earlier cell is also redacted from later cells.
- **`host=` asks before it switches hosts.** A cell naming a host other than the selected one
  waits for a yes (once per host while the runbook is open); approval cards name the cell's host.
  Run all waits at that question, and at the trust and missing-value questions, instead of
  going on to the next cell.
- `autorun=1` in a link no longer starts Run all (only Run All as Copy does); the gate passes
  unsigned text to the shell without writing it (with its secrets) to disk; a link's runbook
  is refused by its size before it is read; the relay's `*:22` reaches public hosts only.

## 0.9.1

- **The toolbar's Run, Values, Assistant, Share and Help show.** In 0.9.0 VS Code drew them as
  blank 21-pixel buttons (it shows an extension's submenu in the notebook toolbar as a bare icon,
  and dropped the icon). They are now labeled buttons, each opening a list of its actions to
  click or type in; the toolbar's **⋯** has the same five menus as submenus.
- **README:** a new demo GIF and screenshots, with the current toolbar.

## 0.9.0

- **Every command is in the runbook's toolbar**, no command palette needed: **Run**, **Values**,
  **Assistant**, **Share** and **Help** dropdowns next to Resume Run and the session switch.
  Approve and Reject are in a cell's ⋯ menu while the runbook has proposals. New: **Get
  Started** (the walkthrough) and **Cheat Sheet** in Help.
- **Cheat sheet** (`docs/cheatsheet.md`, Help ▸ Cheat Sheet): every action of the extension, the
  app and the command line, where it is, and when it matters to you.
- **Open in the App** (Share ▾) copies a link that opens the runbook in the md-runbook app on a
  phone (its GitHub or GitLab file), and warns when the phone would get an older version. See
  `docs/switching.md` for moving runbooks between VS Code and the app.
- **The app** (in development) got the extension's features and names: one-tap Run all /
  Continue / Run again with progress, ⋯ More with every action (searchable), a cell's ⋯, steps,
  sessions, Run All as Copy, reports and sharing, secrets and inputs, the assistant, approving
  proposals with the same policy, `${out:NAME}` captures, breakpoints, Explain on a line, and
  output history with Compare With Previous Run; proposals no longer run there unapproved.
- **Set Inputs** asks for every `${input:NAME}` of the runbook, the current values filled in, to
  set or change them before running; **Set Parameters** also covers parameters the cells use
  without declaring them.

## 0.8.0

- **Signed runbooks.** **md-runbook: Sign Runbook** (or `md-runbook sign`) signs a runbook's
  bash blocks with an SSH key (`ssh-keygen -Y sign`) and writes the signature at the end of the
  file, invisible on screen. Servers whose support keys are restricted to the new
  **md-runbook-gate** (`apps/gate`, one POSIX `sh` script) run only runbooks signed by keys
  they trust, unchanged, with scopes, expiry dates, revoked releases, patterns for
  `${param:NAME}`, and a JSON log of every run; unsigned blocks can be allowed per server or per
  key. `md-runbook verify` shows what a signature covers; lint and the editor warn about blocks
  changed since signing. New cell option `lines=any` (single lines of a signed block may run)
  and setting `mdRunbook.signing.key`. See `docs/features/signed-runbooks.md`.
- **Lint:** `host=` is a known cell option (it was reported as unknown).
- **The md-runbook app** (in development, not in the stores yet) runs signed runbooks through
  md-runbook-gate, shows who signed them, and asks for `${param:NAME}` values on the runbook.

## 0.7.0

- **`host=NAME` blocks** are for the md-runbook app, which runs them on that host over SSH. The
  extension and the CLI run cells on this machine, so they never run one, even with cell
  options turned off: Run All passes over it, ▶ does nothing, the cell's status line says
  `Runs on NAME · not run here`, and progress counts it as skipped. Before, the option was
  unknown and such a block would have run locally.
- **Syntax reference** (`docs/syntax.md`): the whole file format on one page, written from the
  parser: fence info-string grammar, every cell option with its value type, placeholders, front
  matter keys, output markers and their attributes, and a checklist for an assistant that
  writes runbooks. Linked from the README, the CLI README and the default **Copy for AI** header.
- **Settings regrouped** (no key changed): editor settings (code lens, lint, line buttons,
  breakpoints) have their own group **Editor and lines**; the context recording settings and
  the status bar ones sit under **Saved output**; `execution.refreshPath` under **Running
  cells**; the four **Copy for AI** settings have their own group, leaving **AI assistant** with
  the model and privacy settings.
- **On Open VSX** as well as the Visual Studio Marketplace, so Cursor, Windsurf and VSCodium can
  install it; each release now publishes to both.
- **README**: a demo GIF at the top (Run All, a retried check, then the same file as plain
  Markdown with the output saved in it), store links, and a comparison with Runme.

## 0.6.0

- **A block for another OS says so before you click it:** its status line reads
  `⊘ For macOS · not run on Windows`. VS Code shows ▶ on every code cell and cannot hide it
  for one, so clicking it still only reports which OS the block is for.
- **Tools installed by a runbook are found by its next step (Windows):** every cell inherited
  VS Code's `PATH`, read once when VS Code started, so a runbook that installed Git or uv with
  `winget` in one step failed to find it in the next until VS Code was restarted. Each cell now
  also gets the `PATH` directories added since then, read from the registry (Machine, then User)
  as a new terminal does. They are only appended, so the inherited `PATH` keeps its order and its
  own entries (a virtualenv, a `PATH` set before starting VS Code) still win.
  The shell itself is looked up on it too, so a PowerShell 7 installed by an earlier step runs
  the next `pwsh` cell. A session gets the directories when it starts (**Restart Session** starts
  a new one); a running session keeps its `PATH`. `mdRunbook.execution.refreshPath` (default on)
  turns it off.

## 0.5.0

- **Line hover, plain click:** rest the mouse on a command of a cell (with two or more) for
  **Run line**, **Run lines 1-N** (up to and including it), **Run lines N-end**, **Step from
  here**, **Check**, **Breakpoint**, **Copy with values** and, with an AI provider set,
  **Explain**, with VS Code's own icons. Below the buttons: whether it will ask before running,
  the last known target context (`output.recordContext`), and the current value of each
  `${param:…}`, `${out:…}`, `${input:…}` (secrets never shown). A plain click is enough; the
  inline `▶ ☐` needed Ctrl+click.
- Checked lines get a ☑ in the margin, and the cell's status line has **Run 2 checked lines**,
  one click to run them.
- `mdRunbook.lines.buttons` is now `hover` (default), `inline` (the `▶ ☐` in front of each
  command, as in 0.3.2 to 0.4.0) or `off`. An earlier `true` still means inline, `false` off.
- **Run copies are saved after each run:** `mdRunbook.output.saveAfterRun` is now `"copies"` by
  default, so a file made by **Run All as Copy** has its outputs on disk after every run, also
  when a cell in it is re-run later. Runbooks run in place are still saved only when you save
  them; `true` saves those too (as before), `false` never saves after a run.
- **Slow opens explained:** when a runbook takes more than 10 s to show its cells, md-runbook says
  once that this is VS Code delaying notebooks on a busy computer, and how to avoid it (start VS
  Code with `--disable-renderer-backgrounding`), with **Learn More** and **Don't Show Again**. See
  [Troubleshooting](docs/troubleshooting.md) and the
  [investigation](docs/investigations/notebook-open-slow.md). The integration tests now start
  their VS Code with that flag, so a busy CI runner no longer fails a test for it.

## 0.4.0

- **Regular expressions** in `expect=`, `expect-not=` and `capture=NAME:/…/` now use RE2 syntax,
  which runs in linear time instead of being stopped after 1 second. Look-around and
  back-references are not available: such a cell shows an option error (the linter reports it
  too).
- The parser, writer and the rest of the core moved to a shared package (`packages/core`) that
  the coming phone and web app will use too. No change in behaviour.
- Marketplace: listed under **Testing** (instead of Other), with the keywords checks, ci, junit
  and lint.

## 0.3.2

- **Line buttons:** `▶ ☐` in front of each command of a cell (with two or more): `▶` runs that
  command, `☐` checks it, and **Run Checked Lines** runs the checked ones in order
  (`lines=1,3`). `mdRunbook.lines.buttons` turns them off.
- **Breakpoints:** click the margin of a `bash`, `pwsh` or `cmd` cell to set one; running the
  cell then pauses before that line (`F10` next line, `F5` continue to the next breakpoint,
  `Shift+F5` stop). A breakpoint on a blank line or comment pauses at the next command.
  `mdRunbook.lines.breakpoints` turns them off.
- **Menus:** "…Selection" entries show only when text is selected; the right-click menu of a
  code cell has **Run This Line** / **Step Through from This Line** (they were missing there).
  `F5` while paused now continues to the next breakpoint.

## 0.3.1

- **Security fixes** from a review of the 0.2 and 0.3 features:
  - A value captured by a cell written by an assistant is no longer used by your own cells
    (`${out:NAME}` fails there), and approval now lists `capture=`, `expect=`, `retry=` and
    similar options.
  - Regular expressions from a runbook (`expect=`, `capture=`) may run for at most 1 second, so
    a runaway pattern can't freeze VS Code. `retry=` allows at most 100 attempts, `every=` at
    most 1 hour, and a risky command's confirmation says how often it may run.
  - Front matter `cwd:` and `timeout:` no longer apply to assistant cells, and follow
    `mdRunbook.cellOptions.enabled`. The recorded context comes from the folder the cell runs in.
  - A line run refuses to start if the cell changed while it waited.
  - A `capture-secret=` value is redacted even when another capture of the cell failed.
  - Command line: secrets from environment variables are redacted from every step (also before
    the step that uses them); `capture-secret=` output is printed only once redacted; the
    notification URL is kept out of the cells' environment and redacted; reports and step
    titles are redacted; a malformed placeholder fails its step instead of stopping the run
    (and its notification); `-h`/`--help`/`--version` only count as the first argument.
  - Release workflow: test jobs get a read-only token; the npm token is only in the publish
    step. The Run-workflow template's comments now say that Pages gets every result file, and
    how to protect secrets with environment approvals.

- **Sample runbook:** new sections 13 to 17 try line runs, checks and retries, captured values
  (also secret ones), blocks for one OS, reports, problem markers and the command line.
- **Walkthrough:** a new step for problems, reports and the command line.
- **Command line:** `--json FILE` writes the step results (status, exit code, message, output)
  for scripts.
- CI checks that the sample runbook still does what its text says (`scripts/check-sample.js`).

## 0.3.0

- **Checking runbooks:** invalid or unknown cell options, `${out:NAME}` without an earlier
  `capture=NAME`, undeclared `${param:NAME}` and ignored front matter values are underlined
  while you edit (`mdRunbook.lint.enabled`), and `md-runbook lint` checks files in CI, with
  GitHub annotations on pull requests.
- **Export Report (PDF):** a new command next to Export Report (HTML) prints the report with the
  Chrome, Edge or Chromium already installed (`mdRunbook.report.browserPath` to pick one).
- **GitHub Action:** `uses: smojon/md-runbook@v0.3.0` runs a runbook in a workflow and keeps
  the filled-in runbook and HTML, PDF and JUnit reports. It builds the runner from its own
  source at the version you pin. This repository's CI runs a runbook with it on Windows, macOS
  and Linux.
- **Run from the web:** `examples/github/run-runbook.yml` adds a **Run workflow** button that
  runs a runbook and keeps its results; publishing the report to GitHub Pages is opt-in.
- **Scheduled checks and notifications:** `examples/github/scheduled-check.yml` is a weekday
  health check. `MD_RUNBOOK_NOTIFY_URL` (or `--notify URL`) posts a summary of a failed run to
  Slack, Microsoft Teams (Workflows), Discord or Google Chat; `--notify-on always` also on
  success.
- **npm package (prepared):** the command line is packaged for npm as `md-runbook` and will be
  published with the first release after the npm token is set up. Until then use the GitHub
  Action, or `node out/dist/cli.js` from a clone.
- **Terminal mode:** a cell no longer waits forever when VS Code's terminal never reports the end
  of a command (seen occasionally on Linux): it ends a few seconds after the command has written
  its exit code.
- **Demo runbook** `examples/screenshots.runbook.md`: a realistic restart runbook that only
  prints simulated output, for trying line runs, checks, retries and captures.

## 0.2.0

- **Line by line:** the dropdown next to a code cell's run button has new commands.
  **Run Line or Selection** (`Ctrl+Alt+Enter`, also in the cell's context menu) runs the line
  under the cursor, or the selected text. **Run Lines One by One** runs each line in turn and
  stops at the first that fails. **Step Through Lines** pauses before each line, like a debugger
  (`F10` next, `F5` the rest, `Shift+F5` stop), and **Step Through from This Line** starts at
  the cursor. Each line shows as `$ command` in the output, and `cd` and variables carry over
  between lines, in `terminal` cells too. A run that didn't cover every line is saved with
  `lines=` and doesn't count as done.
- **Checks:** `expect="text"` or `expect=/regex/`, `expect-not=…` and `expect-exit=N` cell
  options. A step whose output isn't what the runbook expects fails, even with exit code 0
  (`check=failed` on the marker), and `expect-exit=1` makes exit code 1 a pass.
- **Retries:** `retry=10 every=15s` runs a cell again until it passes, for "wait until ready"
  steps. Only the last attempt's output is kept; the marker records `attempts=`.
- **Captured values:** `capture=NAME` or `capture=NAME:/regex/` keeps a value from a cell's
  output, and later cells use it as `${out:NAME}`. `capture-secret=NAME` redacts the value
  everywhere and never saves it.
- **Blocks for one OS:** `os=windows` or `os=linux,macos` on a block. Blocks for another OS are
  not run (and keep their output), and adjacent alternatives count as one step, so one runbook
  works on Windows, Linux and macOS.
- **Command line:** `md-runbook run file.md` (`out/dist/cli.js` in a clone of the repository)
  runs a runbook outside VS Code, for CI, servers and scheduled checks, with the same cell
  options, checks and redaction. It writes the outputs into the file and can write HTML, PDF
  (with an installed Chrome, Edge or Chromium) and JUnit reports, plus a GitHub Actions job
  summary. Risky commands need `--yes`, secrets come from environment variables, and proposed or
  assistant-written cells never run.
- **Get started walkthrough:** *Help → Welcome → Get started with Markdown Runbook* walks
  through running steps, line runs, sessions, placeholders, checks and sharing.
  **md-runbook: Open Sample Runbook** opens a safe sample as an untitled runbook.
- **Save after each run:** with `mdRunbook.output.saveAfterRun` on, the runbook is saved after
  every run, so outputs are on disk even if VS Code closes.
- **Runbook defaults:** `cwd:` and `timeout:` in the front matter set the folder and timeout for
  every cell of a runbook; a cell's own `cwd=` / `timeout=` still wins.
- **Report:** prints cleanly (light colours, wrapped output) for PDF and paper.

## 0.1.2

- **Checklists:** clicking a checkbox, or **Check Next Item**, now shows the tick right away.
  Before, the file changed but the box only looked ticked after reopening the runbook.
- **Sample runbook:** the terminating-error example no longer leaves `$ErrorActionPreference =
  'Stop'` set in session mode, which made the next cell's `Write-Error` fail and stopped Run All.

## 0.1.1

- **Faster start:** the extension is now bundled into a single file, so it loads much faster
  when VS Code opens a runbook.
- **Clickable checklists:** `- [ ]` items in Markdown cells show as checkboxes; clicking one ticks
  or unticks it in the file.
- **Earlier runs in the notebook:** with `mdRunbook.output.historySize` set, a cell's status line
  shows how many earlier runs are kept (`exit code 0 · 1.2s · bash · 2 earlier runs`), and a
  collapsed section below it expands to their outputs.
- **Tidier settings:** the settings are grouped into sections (Running cells, Saved output, Safety
  and redaction, Secrets and environment, AI assistant, Assistant proposals), with the common
  ones first.
- **Session mode at a glance:** the notebook toolbar button now reads **Session: on** or
  **Session: off** for the open runbook instead of "Toggle Session Mode"; clicking it switches.
- **Terminal mode:** window-title codes (e.g. `]0;C:\WINDOWS\...\powershell.exe`) no longer
  appear in the output.
- **Terminal option explained:** a cell marked `terminal` while terminal mode is off now says so
  in its output instead of being ignored silently.
- **New icon**, and **Copy Cell for AI** in the cell toolbar is now an icon instead of text that
  overlapped the other buttons.
- New sample runbook, `examples/sample.runbook.md`, for trying every feature by hand.

## 0.1.0

First release (preview).

- Open Markdown files as notebooks ("Open as Runbook"), with a byte-identical round trip.
- Run `sh`/`bash`, `pwsh`/`powershell` and `cmd` blocks natively on Windows, macOS and Linux.
- Live streaming output, cancel and timeout with process-tree kill, Run All with stop on failure.
- Outputs persisted in the `.md` file, with secret redaction, ANSI stripping and truncation.
- "Clear All Outputs" command.
- Terminal mode (`mdRunbook.terminal.mode`, off by default): run cells in a VS Code terminal to
  answer interactive prompts, with output and exit code still saved.
- Proposed cells with approval, an audit trail, a command policy and read-only credentials for
  assistant-written cells (which never run inside a shared session).
- Copy for AI / Paste AI Proposal with untrusted-output boundaries, pseudonymization and a leak
  check; Check for Leaks.
- AI assistance (Explain Output, Suggest Next Steps, Summarize Incident) via VS Code language
  models or the Claude API. Off by default.
- Secure defaults throughout; security-sensitive settings are user-settings only.
- Persistent session mode (`mdRunbook.execution.mode: session`) with Restart/Stop Session, a
  per-runbook toggle, `mode:` in front matter and `mdRunbook.session.resetOnRunAll`.
- Secrets in the OS keychain, `${secret:…}` / `${input:…}` / `${param:…}` references passed as
  environment variables, front-matter parameters, `.env` files and exact-value redaction.
- Per-cell fence options (`timeout=`, `cwd=`, `env.X=`, `continue-on-error`, `skip`,
  `confirm`), confirmation before risky commands (declining stops Run All), and context
  attributes recorded in output markers.
- Mark steps done/skipped, checklist progress in the status bar, Resume Run, Clear Outputs
  Above/Below.
- Output history in a collapsed `<details>` block, Run All as Copy, `changed=` attribute and
  Compare With Previous Run.
- "▶ Run" CodeLens in the Markdown text editor and HTML report export.
- Output markers record `ended=` and `duration=`.

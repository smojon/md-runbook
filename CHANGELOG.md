# Changelog

## Unreleased

- **VS Code: the Runbook Steps view** (Explorer, while a runbook is open): the same rail as the
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
- **A block's bar that moves.** In VS Code the running block's bar is 24 characters in eighths
  (it was 10 `#`, moving in tenths), with a warning icon once past its estimate. After a run
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
  signature, and nothing checked it outside a gate: `md-runbook verify` now says "signed by X (as
  the file says)" and "signature: NOT checked" without `--allowed-signers`, and the app shows the
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
  "Runs on NAME · not run here", and progress counts it as skipped. Before, the option was
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

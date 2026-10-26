# md-runbook cheat sheet

Every action, where to find it, and when it matters to you. **App** says whether the md-runbook
app (iPhone, Android, browser) has it too.

In VS Code everything starts from the **toolbar at the top of a runbook**: a few buttons, then
the **Run**, **Values**, **Assistant**, **Share** and **Help** buttons; each opens a list of its
actions to click or type in (the same menus are in the toolbar's **⋯**). A cell's own actions
are in its **⋯** menu, and each line of a code cell shows its actions when you hover it. If you
know what you want, Ctrl+Shift+P (⌘⇧P) and type part of its name.

In the app, the top of a runbook has one button that does the obvious thing (**▶ Run all**, then
**▶ Continue** after a stop, **↻ Run again** when all is done), and **⋯ More** lists every other
action by the same groups, with a search field (Ctrl/⌘+K with a keyboard).

## Opening a runbook

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Open as Runbook** | right-click a `.md` in the Explorer; the notebook icon of a Markdown editor | You have a Markdown file with shell blocks and want to run them step by step, with the output kept in the file. | **Open a runbook…** on the start screen |
| **Open as Markdown Text** | toolbar (Markdown icon) | You want to edit the raw file: fix a typo in prose, rearrange sections, review the diff. | — |
| **Open Sample Runbook** | Help ▾ | You're new and want to try every feature on a safe file. Nothing is written until you save it. | on the start screen; ⋯ More → Help |
| **Get Started** | Help ▾ | A short tour of the main features, the first time you use it. | — |
| **Cheat Sheet** | Help ▾ | This page, inside VS Code: "is there a button for…?" | ⋯ More → Help (opens this page) |

## Running

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Run cell** / **Run All** / Run Above / Run Below | the cell's ▷, the toolbar's Run All (VS Code's own) | The normal way: run one step, or the whole procedure top to bottom. Run All stops at the first failure. | ▷ on each cell; **▶ Run all** at the top of the runbook |
| **Resume Run** | toolbar, Run ▾ | A step failed, you fixed the cause: carry on from the failed step without re-running the ones that worked. | **▶ Continue** at the top after a stop; ⋯ More → Resume Run |
| **Run All as Copy** | Run ▾ | The runbook is a template (a release checklist, an incident procedure): every run goes into a new dated copy, so the original stays clean and each run has its own record. | ⋯ More → Run All as Copy (the copy opens and runs) |
| **Go to Next Step** | Run ▾ | A long runbook: jump to the first step that isn't done yet. | ⋯ More → Go to Next Step |
| **Session: on / off** | toolbar | **On**: one shell for the whole runbook, so `cd`, variables and logins carry over from cell to cell, as in a terminal. **Off**: every cell starts clean, so the result never depends on an earlier cell. | ⋯ More → Session: on / off (the front matter’s mode: decides at first) |
| **Session…**, **Restart Session**, **Stop Session** | Run ▾ | The session got into a bad state (wrong folder, a stuck login): start again from a clean shell without closing the runbook. | ⋯ More → Restart Session |
| **Clear All Outputs** | Run ▾, right-click the file in the Explorer | Before sharing or committing a runbook as a template, without the last run's output. | ⋯ More → Clear All Outputs |
| **Start Incident** | Run ▾ | You're paged: a dated run copy with `incident:` and `severity:`, where every run records who ran it and where, every attempt is kept, and a first note marks when it was detected. Export Report then shows the incident record and timeline. | ⋯ More → Start Incident |
| **Add Note** | Run ▾ | During an incident or a drill: record a decision ("called the DBA, failover approved") or a milestone (detected, mitigated, resolved) with the time and your name, for the timeline and the postmortem. | ⋯ More → Add Note |
| **Clear Outputs Above** / **Clear Outputs Below** | cell ⋯ | You rerun the second half of a procedure and want to see clearly what ran this time. | the cell’s ⋯ (or a long press) |
| **Run Code Block in Text Editor** / **Run Code Block and Below in Text Editor** | ▶ Run above each block in the plain Markdown editor (turn on `mdRunbook.codeLens.enabled`) | You prefer editing the raw file and want to run a block without switching to the runbook view. | — |

## Line by line

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Run line** (▷ on the line) | hover a line | Run one command of a block, for example only the check, not the change. | tap a line → **Run line** |
| **Run lines 1-N** / **Run lines N-end** | line hover | Run a block up to a point, or from a point on, after fixing one command. | tap a line |
| **Step from here** / **Step Through Lines** | line hover; the cell's run dropdown | Risky changes: run one command, look at the result, then decide to continue. While it waits, the cell shows **Run Next Line** (F10), **Run Remaining Lines** (F5) and **Stop Stepping** (Shift+F5). | tap a line → Step from here / Step through, then Run next / Continue |
| **Check** a line, **Run Checked Lines**, **Uncheck All Lines** | line hover; the cell's run dropdown | Pick a few commands out of a long block and run just those, in order. | tap a line → Check, then Run checked |
| **Breakpoint** | line hover | The cell should run on its own but pause before one dangerous command. | tap a line → Breakpoint (a red dot); Run next / Continue while paused |
| **Run Lines One by One** | the cell's run dropdown | Find which line of a block fails: stops at the first failing line and says which. | — |
| **Run Selection**, **Step Through from Selection** | the cell's run dropdown, right-click in the code | You selected part of a command (a long pipeline) and want to try just that. | — |
| **Run This Line**, **Step Through from This Line** | right-click in the code | The same as the line hover, from the keyboard focus or when you prefer menus. | — |
| **Copy with values** | line hover | Paste a command into a terminal or a ticket with the parameters filled in (secrets stay as references). | — |
| **Run Line or Selection**: Ctrl+Alt+Enter (⌘⌥Enter) | in a cell | Run the line under the cursor or the selection without the mouse. | — |

## Steps and progress

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Mark Step Done** / **Mark Step Skipped** / **Unmark Step** | cell ⋯ | Steps you do by hand (call the vendor, check a dashboard): record them, so progress and Resume Run know where you are. | the cell’s ⋯ (or a long press) |
| **Check Next Item** | ⋯ of a Markdown cell | Tick the next `- [ ]` item of a checklist without editing the text. | tap the task box; ⋯ More → Check Next Item |
| **Compare With Previous Run** | cell ⋯ | "Was it like this yesterday?": diff the output with the run before (with output history turned on). | the cell’s ⋯ → Compare With Previous Run (with Hosts & settings → Output history on) |

## Values: parameters, inputs, secrets

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Set Parameters** | Values ▾ | One runbook for several targets (`${param:NAMESPACE}`, `${param:REGION}`): set them once before running, instead of answering a prompt per cell. | the **Parameters** card on the runbook |
| **Set Inputs** | Values ▾ | Values that differ per run (a ticket number, a user name, `${input:NAME}`): set or change them before running. | asked when a cell needs one; the **Inputs** card shows, changes and clears them |
| **Reset Inputs** | Values ▾ | You start a new run with other values: forget this runbook's inputs and parameters, so they're asked again. | **Clear all inputs** on the Inputs card; ⋯ More → Reset Inputs |
| **Set Secret** | Values ▾ | Store a token or password once (`${secret:NAME}`) in the OS keychain, instead of pasting it into commands. Setting it again changes it. | asked the first time; **Hosts & settings → Secrets → Add a secret / Change** |
| **List Secrets** | Values ▾ | See which secrets are stored (never their values) and copy a `${secret:NAME}` reference to write into a cell. | Hosts & settings → Secrets |
| **Delete Secret** | Values ▾ | A token was rotated or should no longer be used on this machine. | Hosts & settings → Secrets → **Forget** |

Values never become part of the script: they reach the shell as environment variables, and
secret values are redacted from the output.

## Assistant (AI)

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Suggest Next Steps** | Assistant ▾, cell ⋯ | You're stuck in an incident: get proposed commands as cells that only run after you approve them. Needs an AI provider. | ⋯ More → Assistant, or the cell’s ⋯ (Claude with your own key; every send confirmed, with the leak check) |
| **Explain Output** / **Explain** (a line) | cell ⋯ / line hover | An error or an output you don't understand: get it explained next to the runbook. | the cell’s ⋯ → Explain Output; tap a line → Explain |
| **Summarize Incident** | Assistant ▾ | Write the findings of an incident at the end of the runbook, as a draft to edit. | ⋯ More → Assistant, or the cell’s ⋯ (Claude with your own key; every send confirmed, with the leak check) |
| **Copy for AI** / **Copy Cell for AI** | Assistant ▾ / the cell's copy icon | Use the chat assistant you already have: copy the runbook with names pseudonymized and secrets removed. | ⋯ More → Copy for AI; the cell’s ⋯ → Copy Cell for AI |
| **Paste AI Proposal** | Assistant ▾ | Bring the assistant's answer back: its code blocks become proposed cells, with the real names restored. | ⋯ More → Paste AI Proposal (or the cell’s ⋯, to insert after it) |
| **Check for Leaks** | Assistant ▾ | Before you share a runbook or its output: find tokens, keys and internal host names in it. | ⋯ More → Check for Leaks |
| **Approve Proposed Cell** / **Reject Proposed Cell**, **Approve All Proposals**, **Go to Next Proposal** | cell ⋯ and the cell's status line / Assistant ▾ (when there are proposals) | Commands written by an assistant or a colleague never run until you read and approve them. | the cell’s ⋯ → Approve / Reject; ⋯ More → Assistant (the extension’s built-in policy, approvals kept on the device) |
| **Set Anthropic API Key** / **Clear Anthropic API Key** | Assistant ▾ | Using Claude directly as the AI provider. | ⋯ More → Assistant |

## Share

| Action | Where | When it matters to you | App |
| --- | --- | --- | --- |
| **Export Report (HTML)** / **Export Report (PDF)** | Share ▾, right-click the file in the Explorer | Send the result of a run to someone without VS Code: a change record, an incident report, an audit. | ⋯ More → Share (through the share sheet; in a browser: download, print to PDF) |
| **Export Run Record (JSON)** | Share ▾ | Hand the run record to an audit or ticket tool: the timeline, its summary (incident, times to mitigate and resolve, failed runs) and the record's signature, as `<name>.record.json`. | ⋯ More → Share → Export Run Record (JSON) |
| **Request Co-signature** | Share ▾ | Four eyes, step one: copies a message with a link that opens the signed runbook (its pushed file, pinned) on **Co-sign Runbook** in the reviewer's app. | ⋯ More → Share → Request Co-signature (the link carries the runbook; the reviewer sends it back with Share Runbook) |
| **Sign Run Record** | Share ▾ | After an incident or a drill: vouch for the record as it happened (outputs, notes, earlier attempts), so its report and `md-runbook verify` show any later change. On a signed, unchanged record it co-signs (an incident or drill lead). | ⋯ More → Sign Run Record (the app's key) |
| **Co-sign Runbook** | Share ▾ | Four eyes: a reviewer adds a signature to the signed runbook as it is, for servers that need two signers (`signers = 2`). Refused if the runbook changed since it was signed. | ⋯ More → Co-sign Runbook (the app's key) |
| **Sign Runbook** | Share ▾ | Release a runbook for a support team: servers restricted to md-runbook-gate run only signed runbooks, unchanged. See [signed runbooks](https://github.com/smojon/md-runbook/blob/main/docs/features/signed-runbooks.md). | ⋯ More → Sign Runbook (the app's key); shows who signed it and which blocks changed |
| **Open in the App** | Share ▾ | Continue on your phone: copies a link that opens this runbook (its GitHub or GitLab file) in the md-runbook app. It warns when the phone would get an older version (changes not committed or not pushed). | **Open a link…** on the start screen; mdrunbook://open?url=… links |
| **Make QR Code** | Share ▾ | A label for a machine, a slide or a screen: a QR code (`<name>.qr.svg`) of the runbook's pushed file (pinned) or of the runbook itself (no network needed), with an optional host and parameter values. Many machines at once: `md-runbook qr --labels hosts.csv`. | **Scan a code** on the start screen opens it; ⋯ More → Share → **Show QR Code** shows one for another phone |
| Save | Ctrl+S | Outputs are written into the `.md` file: commit it, and the run is in Git. | **Save to the file** (or **Download** in browsers that can't write files) |

## Only in the app

| Action | Where | When it matters to you |
| --- | --- | --- |
| **Add a host**, edit, **Delete this host** | Hosts | Each server you run on, once: name, address, user. |
| **Run on** (host chips) | top of a runbook | Pick the server the cells run on. A cell with `host=NAME` always runs on that one. |
| **Practice on a Host…** / **Stop Practice** | ⋯ More → Run | A drill or training: every cell runs on a practice server, whatever `host=` says (also `practice: NAME` in the front matter). |
| **Scan a code** | start screen | Open the runbook a QR code carries (a label on a machine, another phone's **Show QR Code**). |
| **Pin** a runbook | the pin on its row | Keep the runbooks you need first at the top, and on the app icon's long-press menu. |
| **Ask for Face ID or a fingerprint before the key is used** | Hosts & settings → This app's SSH key | A lost or stolen phone can't use the key (makes a new key: put its public key on your hosts again). |
| **Trust and run** | shown on the first connection | Check the server's fingerprint before anything is sent. If a known server's key changes, the app stops and tells you. |
| **Forget the trusted host key** | Hosts & settings → a host | The server was reinstalled and has a new key on purpose. |
| **This app's SSH key → Copy** | Hosts | Put the app's public key into `~/.ssh/authorized_keys` on each server. On phones the private key stays in secure hardware. |
| **Relay** address and token | Hosts (browser only) | The browser can't open SSH connections itself: it goes through your relay. |
| **Share Runbook** | ⋯ More → Share | Hand the .md with its outputs to VS Code or a colleague (mail, Files, AirDrop, Slack). |
| **Remove** a runbook | start screen | Take a runbook off the app (it asks if it has unsaved changes). |

## Command line

| Command | When it matters to you |
| --- | --- |
| `md-runbook run file.md` | Run a runbook in CI, on a server or on a schedule, with the outputs written into the file (`--report`, `--junit`, `--param`, `--notify`). |
| `md-runbook lint file.md` | Catch typos in cell options and missing values before anyone runs it, in a pull request. |
| `md-runbook sign file.md --key KEY` | Release a runbook for servers with md-runbook-gate, from your machine or from CI. |
| `md-runbook verify file.md` | Check what a signature covers and which blocks changed since signing. |

Moving a runbook between VS Code and the app:
[switching](https://github.com/smojon/md-runbook/blob/main/docs/switching.md).

More: [command line](https://github.com/smojon/md-runbook/blob/main/docs/features/cli.md),
[file format](https://github.com/smojon/md-runbook/blob/main/docs/syntax.md), and the feature
pages linked from the [README](https://github.com/smojon/md-runbook#more-features).

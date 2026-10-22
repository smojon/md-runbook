# Moving between VS Code and the app

A runbook is one `.md` file, and both md-runbook clients read and write the same format. What
a run leaves behind is in the file, so whichever client opens it next carries on where the last
one stopped: **Continue** in the app and **Resume Run** in VS Code pick the same next step.

| In the file (moves with it) | Kept per client (doesn't move) |
| --- | --- |
| outputs and their history, exit codes, `lines=` of line runs | parameter and input values typed for this session |
| ticked checklist boxes, steps marked done or skipped | stored secrets (each client's keychain; never in the file) |
| proposals and approval stamps | approvals themselves: a proposal approved on one device is approved again on the other, by design |
| the signature block of a signed runbook | the hosts (app) and the shells (VS Code) |

## Three ways to move a runbook

**1. A synced folder: both ways, nothing to send.** Keep runbooks in iCloud Drive, OneDrive,
Google Drive or Dropbox. VS Code opens the folder; the app opens the file with **Open a
runbook…** (the Files app on iPhone, the system picker on Android, Chrome or Edge in a browser)
and **Save to the file** writes back to the same file. If the file changed elsewhere since the
app read it, the app asks whether to overwrite it or load that version.

**2. A Git repository and a link: from VS Code to the phone.** **Share ▾ → Open in the App**
copies a link (`mdrunbook://open?url=…`, the file's GitHub or GitLab address). Send it to your
phone by mail or chat; tapping it opens the runbook in the app. The phone downloads the pushed
version, so the command warns when the file has changes that are not committed or not pushed.
In the app, **Open a link…** on the start screen takes the same address, or any `https` link to
a runbook. The repository must be reachable from the phone (a public one, or a file host the
phone can open).

**3. Share: from the app to VS Code (or to a colleague).** **⋯ More → Share Runbook** hands the
`.md` with its outputs to the share sheet: mail, AirDrop, Files, Slack. Open it in VS Code and
everything the app ran is there. **Export Report** (HTML or PDF) is the same run for someone who
uses neither client.

## The same names in both

The app's **⋯ More** uses the groups of the extension's toolbar, with the same names, so what
you learned in one works in the other: **Run** (Run All, Resume Run, Run All as Copy, Go to Next
Step, sessions, Clear All Outputs), **Steps** (Mark Step Done / Skipped, Check Next Item),
**Values** (parameters, inputs, secrets), **Assistant** (Suggest Next Steps, Explain Output,
Summarize Incident, Copy for AI, Paste AI Proposal, Check for Leaks, approving proposals),
**Share** (Export Report, Share Runbook, Sign Runbook in VS Code) and **Help**. A cell's **⋯**
holds the cell's own actions in both. The [cheat sheet](cheatsheet.md) lists every action and
where it is in each client.

## What only one of them does

| Only in VS Code | Only in the app |
| --- | --- |
| runs on this machine (bash, PowerShell, cmd), terminal mode, the text editor's ▶ Run | runs on your servers over SSH, `host=` blocks, the SSH key in the phone's secure hardware |
| **Sign Runbook**, `md-runbook sign` / `verify` (the app shows signatures and runs signed runbooks) | the relay for running from a browser |
| output history and **Compare With Previous Run**, Explain for a single line, breakpoints | |
| the command line for CI (`md-runbook run`) | |

# Moving between VS Code and the app

A runbook is one `.md` file, and both md-runbook clients read and write the same format.

What a run leaves behind is in the file. So whichever client opens it next carries on where the
last one stopped. **Continue** in the app and **Resume Run** in VS Code pick the same next step.

| In the file (moves with it) | Kept per client (doesn't move) |
| --- | --- |
| outputs and their history, exit codes, `lines=` of line runs | parameter and input values typed for this session |
| ticked checklist boxes, steps marked done or skipped | stored secrets (each client's keychain; never in the file) |
| proposals and approval stamps | approvals themselves: a proposal approved on one device is approved again on the other, by design |
| the signature block of a signed runbook | the hosts (app) and the shells (VS Code) |

## Three ways to move a runbook

**1. A synced folder: both ways, nothing to send.** Keep runbooks in iCloud Drive, OneDrive,
Google Drive or Dropbox.

VS Code opens the folder. The app opens the file with **Open a runbook…**. It uses the Files app
on iPhone and the system picker on Android; in a browser, Chrome or Edge.

**Save to the file** writes back to the same file. If the file changed elsewhere since the app
read it, the app asks: overwrite it, or load that version?

**2. A Git repository and a link: from VS Code to the phone.** **Share ▾ → Open in the App**
copies a link (`mdrunbook://open?url=…&sha256=…`, the file's GitHub or GitLab address, pinned to
the pushed file).

Send it to your phone by mail or chat; tapping it opens the runbook in the app. The phone
downloads the pushed version. So the command warns when the file has changes that are not
committed or not pushed.

If someone pushes a change before you tap the link, the app refuses the new text. That text isn't
the one the link pins. You send a fresh link.

In the app, **Open a link…** on the start screen takes the same address. It also takes any
`https` link to a runbook. The repository must be reachable from the phone (a public one, or a
file host the phone can open).

**3. Share: from the app to VS Code (or to a colleague).** In the app, **⋯ More → Share Runbook**
hands the `.md` with its outputs to the share sheet: mail, AirDrop, Files, Slack.

Open it in VS Code and everything the app ran is there. **Export Report** (HTML or PDF) is the
same run for someone who uses neither client.

## Runbook links

A link only opens the runbook and fills in what it names: it never runs anything. The same link
format works from:

- VS Code;
- a QR code on a machine;
- a pager alert;
- a "please co-sign" mail.

```
mdrunbook://open?url=https%3A%2F%2Fgithub.com%2F…%2Frestart.md&sha256=…&host=web-1&p.SERVICE=api
```

| Field | What it does |
|---|---|
| `url=` | The runbook's `https` address (a GitHub or GitLab file page works). |
| `rb=` | The runbook itself, deflated and in base64url, instead of `url=`: no network needed (a QR code holds about 2 KB of it). |
| `sha256=` | SHA-256 of the runbook's text (hex; a leading BOM doesn't count). Any other text is refused. |
| `host=` | The name of a host in the app to run on. A link never adds a host: if there is none of that name, the runbook says so. |
| `p.NAME=` | A value for the runbook's parameter `NAME` (one line). A signed runbook still checks it against its pattern, and md-runbook-gate checks it again. Names the runbook doesn't use are ignored. |
| `action=cosign` | Opens on **Co-sign Runbook**, or says why it can't be co-signed. |

Unless the runbook at that address changed since, opening the same link again opens the app's
copy. It opens with the link's values. A new version is a new copy.

The app says what it opened:

- **signed**: a signature block, no signed block changed;
- **pinned**: the text at the link's address is the one its `sha256=` names;
- neither.

The last two come with a warning to check where the link came from.

Only a signature says who approved a runbook. Anyone can make a link, and a forged link or
sticker can pin its own text. So:

- a pin protects a genuine link from the file changing later;
- a runbook carried in the link (`rb=`) never counts as pinned.

**Hosts & settings → Links → Open only signed runbooks from links** refuses anything unsigned;
servers with md-runbook-gate check the signature itself. The web app takes the same fields at its
own address, `https://<web app>/open?…`.

A link whose `url=` is a file in the app's team library opens the library copy, not its own copy:

- its outputs;
- Update / Keep mine;
- the library's rules: a library that opens verified runbooks only refuses an unverified file
  through a link too.

See [team runbooks](app.md#team-runbooks).

### QR codes

A runbook link fits in a QR code, for a label on a machine, a slide or a colleague's screen.

- **In VS Code:** **Share ▾ → Make QR Code** asks:
  - what the code carries: the pushed file, pinned, or the runbook itself, which needs no
    network;
  - an optional host and parameter values.

  It writes `<name>.qr.svg` next to the runbook, and copies its link too.
- **On the command line:** `md-runbook qr file.md --labels hosts.csv --out labels.pdf` prints a
  sheet with one code per machine, each with its own host and parameter values
  ([options](features/cli.md#qr-codes-and-labels)).
- **In the app:** **Scan a code** on the start screen opens a code like any link. Nothing runs,
  and the runbook says whether it is signed.

  **⋯ More → Share → Show QR Code** shows a code for another phone to scan. It can include the
  selected host and parameter values. The card says which kind of code it shows:
  - **Link to its address**: `https://<web app>/open?url=<its address>&sha256=<hash>`. It's the
    default for a runbook from an address (a team library copy, or one opened from a `url=`
    link).

    The hash is of its text without outputs. The code is small whatever the runbook's size, and
    pinned. The other phone downloads the runbook and refuses any other text.

    A library file opens as that phone's own library copy. The address starts with the web
    app's [public address](app.md#the-public-address) when it is on the web app's own server.

    This kind isn't offered when your copy has its own edits, or the file there changed since
    your copy. The card says why.
  - **The runbook itself** (`rb=`, without outputs): for runbooks with no address, or with the
    switch off. It needs no network and takes up to about 3 KB of runbook.

  On the web, codes start with the web app's public address when it is `https`. So a phone's
  camera opens them in the browser. Otherwise they are `mdrunbook://open?…` links for the app.

A code made of the runbook itself works without a network: the phone only needs to reach the
machine. A sticker can be replaced, so sign runbooks you put on labels; servers with
md-runbook-gate run only signed ones.

## The same names in both

The app's **⋯ More** uses the groups of the extension's toolbar, with the same names. So what you
learned in one works in the other:

- **Run** (Run All, Resume Run, Run All as Copy, Go to Next Step, sessions, Clear All Outputs);
- **Steps** (Mark Step Done / Skipped, Check Next Item);
- **Values** (parameters, inputs, secrets);
- **Assistant** (Suggest Next Steps, Explain Output, Summarize Incident, Copy for AI, Paste AI
  Proposal, Check for Leaks, approving proposals);
- **Share** (Export Report, Share Runbook, Sign Runbook in VS Code);
- **Help**.

A cell's **⋯** holds the cell's own actions in both. The [cheat sheet](cheatsheet.md) lists every
action and where it is in each client.

## What only one of them does

| Only in VS Code | Only in the app |
| --- | --- |
| runs on this machine (bash, PowerShell, cmd), terminal mode, the text editor's ▶ Run | runs on your servers over SSH, `host=` blocks, the SSH key in the phone's secure hardware |
| **Sign Runbook**, `md-runbook sign` / `verify` (the app shows signatures and runs signed runbooks) | the relay for running from a browser |
| the command line for CI (`md-runbook run`) | |

# Run reports

A runbook can name an address that hears about every run of it. The address learns who ran which
version, when, and how each step ended.

VS Code, the [md-runbook app](../app.md) and the [command line](cli.md) send the same short
**run summary** at the end of a run. A summary can be **signed with the runner's own SSH key**,
so the server can reject fakes. A [signed runbook](signed-runbooks.md) can make the report, and
its signature, a condition of running at all.

```yaml
---
report-runs: https://reports.example.net/runs   # https; http only for localhost
report-runs-required: true                      # only honoured in a runbook signed by a signer you trust
report-runs-signed: true                        # the same; the summary must be signed with your key
report-runs-token: ${secret:REPORTS_TOKEN}      # optional bearer token, from your secret store
---
```

## What is sent, and what never is

A summary holds names, states and times only:

- the runbook: its file name (no folder), title and the SHA-256 of its text without outputs. For
  a signed runbook, also its signed name, version, the manifest's SHA-256 and the signer;
- who ran it: the user name on the machine, or the name set in the app;
- where: `vscode`, `app-ios`, `app-android`, `app-web` or `cli` (`gate`: md-runbook-gate's own
  report, below);
- when the run started and ended;
- each step, in order:
  - its number;
  - its label (the heading or `name=`, else the first line of its code as written), at most 120
    characters;
  - its state (`passed`, `failed`, `skipped`, `not-run`, `by-hand`);
  - for the steps this run ran, how long they took;
- the totals, and whether the runbook ended green (nothing failed, nothing left to do);
- which alert the run answered, when it had one (below).

**Never** an output, a parameter or input value, a captured value or a secret. A step's label is
the runbook's own text, never what a placeholder was filled with: `deploy --to ${param:TARGET}`
stays that.

The report token is sent as an `Authorization: Bearer` header only, never in the summary. It is
never kept with a queued report: only its secret's name is.

### Which alert a run answered

Alert links open a runbook with the alert's details as parameters, for example
`…&p.ALERT={{ $labels.alertname }}&p.ALERT_FINGERPRINT={{ .Fingerprint }}&p.ALERT_STARTS_AT={{ .StartsAt }}`.
The summary then carries `alert`, built from those parameter values only.

Whether any block uses them doesn't matter. A runbook may declare them with empty defaults
(`- ALERT: ""`). A declared parameter that no block uses is never asked for.

| Parameter | In `alert` |
| --- | --- |
| `ALERT` | `name` (without it there is no `alert`) |
| `ALERT_FINGERPRINT` | `fingerprint` (letters, digits and `. _ : -`) |
| `ALERT_STARTS_AT` | `startsAt` (an RFC 3339 time) |
| `ALERT_LABELS` | `labels`, from `name=value,name=value`, only when the runbook or the link passes it (at most 20) |

Empty values are left out. No other parameter's value is ever read for the summary.

On a server with md-runbook-gate (protocol 3), the app also gives the gate the alert's details
with the runbook. These are its name, fingerprint and start time. So the gate's own log and
`md-runbook audit` say which alert the run answered ([the log](signed-runbooks.md#the-log)).

## The format (version 1)

```json
{
  "v": 1,
  "runbook": {
    "file": "restart-api.md",
    "title": "Restart the API",
    "sha256": "5d1c…",
    "signed": { "name": "ops/restart-api", "version": 7, "manifest": "9a0f…", "signer": "ops@example.net", "trusted": true }
  },
  "who": "ana",
  "client": "vscode",
  "started": "2026-11-14T09:00:00.000Z",
  "ended": "2026-11-14T09:03:10.000Z",
  "steps": [
    { "n": 1, "label": "Tell the channel", "state": "by-hand" },
    { "n": 2, "label": "Stop", "state": "passed", "ms": 1200 },
    { "n": 3, "label": "Start", "state": "failed", "ms": 300 }
  ],
  "ran": [2, 3],
  "totals": { "steps": 3, "passed": 1, "failed": 1, "skipped": 0, "notRun": 0, "byHand": 1 },
  "green": false,
  "alert": { "name": "ApiDown", "fingerprint": "5f3c9e", "startsAt": "2026-11-14T08:58:00Z" }
}
```

- `ran`: the step numbers this run ran (one step, a range, or all of them). `steps` is the whole
  runbook after the run.
- `signed.trusted`: whether the client checked the runbook's signature against signers it
  trusts. `signer` is the principal that matched, otherwise only what the file says.
- `stopped: true` when the run was stopped or timed out.
- Times are ISO 8601 in UTC; `ms` is whole milliseconds.
- **Client `gate`**, [md-runbook-gate's own report](signed-runbooks.md#run-reports-from-the-gate)
  of a session on a server:
  - `runbook.signed` is always there;
  - `runbook.file` and `runbook.sha256` are not (the gate sees only the signed manifest);
  - `gate` says where it ran: `{ "host": "web-1", "account": "support", "from": "192.0.2.7" }`.

  Only a gate's summary may carry `gate`, or leave out the file and hash. The format version
  stays 1: these are additions.

A server should refuse a `v` it doesn't know and any field not listed here. Core's
`runSummaryProblems` (`packages/core/src/runReport.ts`) does this check.

**The canonical form** is what is signed and sent. It is JSON with every object's keys sorted (by
UTF-16 code units), no whitespace, and absent fields left out. For the strings, whole numbers and
booleans of a summary this is the same text as RFC 8785 (JCS).

## Sending

The client POSTs `application/json` to the address with a 10-second timeout and no redirects
followed. Sending starts after the run is over, and nothing waits for it, so a report never
slows down a run.

- **Unsigned**, the body is the summary itself.
- **Signed**, the body is the envelope:

  ```json
  { "signature": "-----BEGIN SSH SIGNATURE-----\n…\n-----END SSH SIGNATURE-----\n", "signer": "ana@example.net", "summary": { … } }
  ```

  The signature is `ssh-keygen -Y sign -n md-runbook-run` over the canonical summary. `signer` is
  optional and only a hint: the server's allowed runners file decides who signed.

A `2xx` answer counts as delivered. A `4xx` other than 408 and 429 is dropped: sending it again
would get the same answer. Anything else is kept and tried again later.

| Client | Queue | Tried again |
| --- | --- | --- |
| VS Code | global state (this machine) | at the next start, after each run, every 5 minutes |
| App | the app's storage | at app start, after each run |
| Command line | none: tried 3 times (after 1 s and 3 s) | then a warning; exit code `3` only when the report was required and the run passed |

A queued report waits 1, 2, 4… minutes between tries, at most 6 hours. It is dropped after 7
days, or when 100 newer ones are waiting.

## Consent

A runbook can't send anything you didn't agree to.

- **Not required.** The first time a runbook reports to an address, you are asked:
  - VS Code: a notification at the end of the run;
  - the app: a card at the end of the run.

  The question is `This runbook reports its runs to HOST: WHAT IS SENT`. The answers are
  **Allow**, **Not now** (this run only) or **Never**.

  The answer is remembered per address and report token. A runbook that sends another secret to
  the same address is asked about again.

  The command line asks nothing: there the address must be allowed (`--report-to-allowed`).
  Otherwise nothing is sent, and the run says so.
- **Pre-approved addresses** need no question:
  - VS Code: `mdRunbook.reports.allowedAddresses` (user settings only);
  - the app: **Hosts & settings → Run reports**;
  - the command line: `--report-to-allowed ADDRESS` or `MD_RUNBOOK_REPORT_ALLOWED`
    (comma-separated).

  An entry is a host (`reports.example.net`), an origin (`https://reports.example.net:8443`) or
  an address prefix (`https://reports.example.net/runs/`).
- **Required.** A notice before the run, with what is sent: **Run** or **Don't run**. There is
  no "Never": declining means the run doesn't start.

  Once you choose Run, the other steps of the same runbook don't ask again for the session. On
  the command line the address must be allowed, else nothing runs (exit `2`).

## Required and signed reports

`report-runs-required: true` and `report-runs-signed: true` are honoured only when all of these
hold:

1. The runbook carries a signature that verifies against **signers this client trusts**:
   - VS Code: checked with `ssh-keygen -Y verify` against
     - the `allowed_signers` file named in `mdRunbook.signing.allowedSigners`;
     - for your copy of a team library runbook, also the keys trusted from that library
       ([Trusted Signers…](signed-runbooks.md#in-vs-code));
   - the app: the keys under [Hosts & settings → Trusted signers](../app.md#trusted-signers) that
     count for the runbook:
     - for a team library copy, those trusted from its library and those added by you;
     - for any other runbook, those added by you.

     They are checked in the app itself, the same check as the team library's "whole runbook
     verified";
   - the command line: `md-runbook run --allowed-signers FILE`.
2. The signature covers **the whole runbook**: [manifest version 2](signed-runbooks.md#what-is-signed),
   which signs the text, front matter included. A runbook signed before that version only had
   its bash blocks signed: sign it again.
3. Nothing changed since signing (outputs, notes and ticked boxes don't count), and the
   signature hasn't expired.

Otherwise the two settings are ignored, and reporting falls back to asking, as for any other
runbook. `md-runbook lint`, the editor and the app's lint say why: not signed, signed only
partly, or changed since signing. Whether you trust the signer can only be known on your
machine.

With **signed** honoured, the client must sign the summary. Without a key the run doesn't
start, and the message says how to set one up:

- VS Code: `mdRunbook.signing.key`, the same key as **Sign Runbook**;
- the app: its own key (Secure Enclave, Android Keystore), as for Sign Runbook. When it can't
  be used, make a new one under Hosts & settings → This app's SSH key. On the web, turn **Use a
  passkey** off, or off and on again for a new passkey;
- the command line: `--key KEY`.

Without `report-runs-signed`, a summary is signed whenever a key is set, and sent unsigned
otherwise.

## Checking a signed summary on a server

Give each runner's key a line in an **allowed runners** file, OpenSSH's `allowed_signers` format
with the namespace `md-runbook-run`:

```
ana@example.net namespaces="md-runbook-run" ssh-ed25519 AAAA…
support-phone@example.net namespaces="md-runbook-run" ecdsa-sha2-nistp256 AAAA…
```

The app shows its line under **Hosts & settings → Signing runbooks**. Then:

```sh
md-runbook verify-run envelope.json --allowed-runners /etc/md-runbook/allowed_runners
```

It exits `0` when the signature is good, printing the runner and the summary, and `1` when it
is not. `-` reads standard input.

A library server can do the same with core: `verifyRunEnvelope(json, allowedRunnersFile)` in
`@md-runbook/core/node`, which uses ssh-keygen. `parseRunEnvelope` checks the envelope's form
without it.

**Namespaces keep the two kinds of signature apart.** A runbook signature (`md-runbook`) never
verifies as a run summary. A run summary's signature (`md-runbook-run`) never verifies as a
runbook.

Keep runner keys out of the servers' `allowed_signers`, or give them only
`namespaces="md-runbook-run"`.

## Receiving them: the library server

The [library server](../../apps/library-server/README.md) receives summaries at
`https://<your web app>/v1/runs` (`report-runs: https://runbooks.example.net/v1/runs`), next to
the team library it publishes to:

- It checks each one strictly with `runSummaryProblems`, and that its totals and `green` agree
  with its steps.
- A signed one is checked against its allowed runners (`RUNS_ALLOWED_RUNNERS`) with ssh-keygen.
- Every summary is kept as one JSON line, append-only, with when it arrived and how far it can
  be believed:
  - `runner-signed`;
  - `gate` (sent by md-runbook-gate with a gate token);
  - `unverified`.

  `RUNS_REQUIRE_SIGNED=true` refuses the unverified ones.
- `report-runs-token: ${secret:NAME}` is its `RUNS_TOKENS`: the client sends it as
  `Authorization: Bearer`, which the server checks.
- `GET /v1/runs?runbook=…` lists the team's recent runs. `GET /v1/runs/last-green?runbook=…`
  answers `last ran green by X at T`, verified or not. Both need a read token.

## Limits

- **A client can't be forced.** Someone with a modified client, or `curl`, can run a runbook's
  commands without reporting. They can also send a summary that says what they like.

  A signature proves only which key sent the summary, not that the steps really ran as it says.

  Real enforcement is on the server. The [gate](signed-runbooks.md#setting-up-a-server) logs
  every signed block it runs. With `report_to`, it
  [sends its own summary](signed-runbooks.md#run-reports-from-the-gate) of every session,
  whatever the client did.
- A report goes out after the run. A client that crashes or is killed first sends nothing.
- The app checks signatures itself (Ed25519, ECDSA, RSA, security keys and passkeys). A line
  for a certificate authority (`cert-authority`) is not used there. So a runbook signed with a
  certificate is asked about instead.

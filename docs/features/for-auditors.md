# For auditors: approvals, runs and evidence

This page describes what md-runbook records and enforces, and where to find it, for people who
review operations: internal audit, change management, security. It describes mechanisms; it
doesn't claim compliance with any standard. Which controls these mechanisms support is for your
own framework and your auditors to decide.

## The parts

| Who | Does | With |
|---|---|---|
| Author | writes a runbook (a Markdown file with shell blocks) | VS Code, any editor |
| Approver(s) | sign the runbook's blocks: "these exact commands may run" | **Sign Runbook**, **Co-sign Runbook** (VS Code, the app, `md-runbook sign`) |
| Operator | runs it on a server | the app, VS Code, `md-runbook run` |
| Server | runs only signed, unchanged blocks for the operator's key, and logs every run | md-runbook-gate ([signed runbooks](signed-runbooks.md)) |
| Reviewer | checks what ran against what was approved | `md-runbook audit`, Export Report, `md-runbook verify` |

## Approval before execution

- **What is approved.** A signature covers a manifest of the runbook's blocks (their exact code),
  its name and version, the scopes (which servers), the patterns each parameter must match, and
  an optional last day. Prose is not signed. Any change to a signed block, its order or a new
  block breaks the signature for that block.
- **Who approved.** Signatures are SSH signatures (`ssh-keygen -Y`); the server's
  `allowed_signers` file lists the keys it trusts, so a signer is a key, not a name typed into the
  file. `md-runbook verify --allowed-signers FILE` checks them as the server does.
- **Two people.** **Request Co-signature** sends a reviewer a link to the signed runbook;
  **Co-sign Runbook** adds their signature to the same manifest. `signers = 2` in `gate.conf` (or
  per key) makes the server require two distinct signers.
- **Withdrawing an approval.** An expiry date in the signature; a **version floor** per runbook
  in `gate.conf` (`floors = FILE`) so older versions stop running at once; removing a signer from
  `allowed_signers`.
- **Separation of duties.** The approver's signing key grants no access by itself; the
  operator's SSH key is forced to the gate, so it can run approved blocks and nothing else on
  that account. Admin accounts with full shells are outside this, by design: keep them few and
  separate.

## Evidence of execution

- **Server side (independent of the operator).** The gate logs one JSON line per event to syslog
  (tag `md-runbook-gate`) or a file: the session (account, key fingerprint, client address),
  which runbook and version was loaded and which signer the gate accepted, every parameter value,
  every block run, refusals with their reason, unsigned code where allowed (by hash), stops.
  The exit code is written by the account's own shell; for a log the account can't touch, use
  syslog and forward it off the server.
- **`md-runbook audit`** turns those logs into a report (HTML, PDF or JSON): every run with when,
  who, from where, the runbook and signer, the parameters, the exit code and duration, plus the
  findings (refusals, unsigned code, stopped runs). It exits 1 when there are findings, so a
  scheduled CI job can raise them ([options](cli.md#gate-audit)).
- **Endpoint checks (ops host).** On the [ops host](kubernetes.md), md-runbook-probe writes a
  `probe` event to the same log for every endpoint it checks. The event has the key, the client,
  the signed run that made the check, the endpoint and its address, the result, and the
  certificate's expiry and SHA-256 fingerprint. `md-runbook audit` lists these events under
  Endpoint checks, and Export Report lists the same checks in the run record.
- **Client side (the operator's record).** Each run's output goes into the runbook file with its
  start, end, duration and exit code. A runbook with `incident:` or `evidence: true` (**Start
  Incident** writes it) also records who ran each step and on which machine, and keeps every
  attempt, failed ones included. **Add Note** records decisions and milestones.

## Tying the two together

- **`md-runbook audit --record FILE.md`** matches a saved run record against the server log:
  each recorded run of a signed block that the log confirms (same runbook and block, within two
  minutes), and each one the log doesn't show (run elsewhere, unsigned, or a gap in the log).
- **Sign Run Record** has the operator (and, co-signing, a lead) sign the record as it is,
  outputs and notes included; **Export Report** then shows who signed it and whether it changed
  since, and `md-runbook verify` checks those signatures.
- **Export Report** is the human-readable record: the incident's facts (start, end, time to
  mitigate and resolve, the recovery-time objective), a timeline of every run, attempt and note,
  and every step with its output. Secrets are redacted before anything is written.

## What it does not do

- It controls what the operator's key can start on a gated account, not what a signed block does
  once it runs: the review before signing is the real control.
- The prose of a runbook isn't signed: an altered instruction such as "now run X by hand" is not
  stopped, though the gate would refuse X.
- Client-side records are files the operator could edit; that is why the server log, `audit
  --record` and record signatures exist. A record signature shows later changes, not changes
  made before signing.
- Times come from each machine's clock; `audit --record` allows two minutes of difference.
- The gate runs on Linux and macOS servers. Windows servers can be run from the app, but not
  gated.

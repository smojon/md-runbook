# Per-library trust in VS Code (design)

Goal: a key trusted from a team library's `allowed_signers` counts for that library's runbooks
only. The app does so already (`keysFor` in `apps/mobile/src/signing/trust.ts`). Keys you add
yourself count for every runbook.

Status: built for 0.29.0 (src/libraryTrust.ts). Decided 2026-11-16:

1. A library's keys count for reporting on its own runbooks: yes.
2. Keys already in your file move: no.

## Today

- One file for everything: `mdRunbook.signing.allowedSigners`.
- **Trusted Signers… → Add the Team Library's Signers…** writes the library's lines into that file.
  - The modal says so: here they count for every runbook, not only the library's.
- The Library view, run reports, Practice on a Host and links all check against that one file.

## Files

- Your own file stays as it is: `mdRunbook.signing.allowedSigners`. It counts for every runbook.
- One file per library address: `globalStorage/library-signers/<sha256(address)>/allowed_signers`.
  - The address is the library's folder, as `libraryBaseOf` gives it and the app keys it.
  - Core's `normalizeLibraryUrl` makes it: host in lower case, no default port, ends with `/`.
  - Two libraries on one host are two: reading one never withdraws the other's keys.
  - The folder also holds `address.txt`, so Trusted Signers… can show where each file came from.
  - A folder without it (the first, per-host version, never released) is ignored.
- ssh-keygen reads one file per call. A runbook from a library is checked against your file
  first, then against its library's file: two calls at most.
  - `SignerCache` (src/signerCheck.ts) already keys by file and stamp: each file caches on its own.

## Which runbooks are a library's

- The Library view's rows: the library at `mdRunbook.library.url`.
- Your copies of them (`globalStorage/library/<key>/…`, made by `libraryCopy`).
  - Today the copy doesn't record where it came from. New: `libraryCopy` writes `address.txt`
    next to the copy, and `libraryOf(file)` reads it.
  - A file elsewhere, or a copy saved elsewhere, is not a library's: your file only.
- A runbook call's target inherits its caller's library only when it is in the same copy folder.

## Where the check changes

| Place | Today | With per-library trust |
| --- | --- | --- |
| Library view | your file | your file, then the library's |
| signedOnly library, Open | your file | the same as the view |
| Run reports (`report-runs-required`, `-signed`) | your file | your file, then its library's for a library copy |
| Practice on a Host (asks unless signed) | your file | the same as run reports |
| Links (`linkHandler.ts`) | your file | unchanged: a link is never a library's runbook |
| Command line, gate | `--allowed-signers` | unchanged |

The run-report row is why this waits: a library's keys could then make reporting required.
That matches the app, but it changes what a library server can make VS Code do.

## Trusted Signers…

- **Add the Team Library's Signers…** writes to the library's file, not yours.
  - The modal's last point becomes: they count for this library's runbooks only.
- The list shows two groups: yours, then each library's, under its address.
  - Removing a key removes it from the file it is in.
- **Withdrawn keys**, as in the app: a trusted key the library no longer publishes stops counting.
  - Kept as a `# withdrawn YYYY-MM-DD` comment line in the library's file, so ssh-keygen skips it.
  - Published again, it stays withdrawn. A compromised server could re-list a stolen key.
  - **Add the Team Library's Signers…** offers it again, not pre-picked, with "withdrawn on" its
    day. The yes writes the line published now, with its options.
- **Lines as written:** md-runbook writes each line rebuilt from what it read, never as given.
  - Names, `namespaces`, `valid-after`, `valid-before`, key type and key; no comment.
  - Refused: a backslash, a quote outside an option value, or an unquoted value.
  - Refused too: an option given twice, a control character or an unusual blank.
  - OpenSSH reads `\"` as an escape: such a line could show one key and trust another.
- Moving keys: an earlier version wrote library keys into your file. Nothing moves them by itself.
  Trusted Signers… marks those lines as also published by the library's host, and **Remove** takes them out.

## Size

- Files and addresses: about 60 lines (`libraryTrust.ts`, no vscode import, unit-tested).
- Library view, Open, run reports, practice: about 50 lines.
- Trusted Signers… groups, withdrawn keys: about 120 lines.
- Tests: unit tests for the files and addresses.
  - An integration test: a key from library A doesn't verify library B's runbook.

## Open questions

1. May a library's keys make reporting required for its own runbooks, as in the app?
   - Recommended: yes, for consistency with the app.
   - Confidence: medium. The app already does so, and a library's runbooks reach VS Code only
     through the Library view.
2. Should keys already in your file from an earlier **Add the Team Library's Signers…** move?
   Recommended: no automatic move; show them, as above. Moving trust without asking would surprise.

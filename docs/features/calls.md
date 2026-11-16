# Running another runbook as one step

A procedure that is the same every time often wraps a part that changes every time. An upgrade
is always: where am I, the way back is ready, checks green before, deploy, checks green after.

What each release changes is in its own file. A `runbook` block runs that file as **one step** of
the current runbook:

````markdown
```runbook name="Apply the release's changes" src="releases/${param:TO}.runbook.md"
ENV=${param:ENV}
CONTEXT=${param:CONTEXT}
TENANT=${param:TENANT}
```

```runbook name="The way back: restore" src="1-backup-restore.runbook.md" section="Part B" confirm
ENV=${param:ENV}
BACKUP_DIR=${out:BACKUP_DIR}
```
````

- `src=` is the runbook to run, relative to this file. It may use `${param:NAME}` and
  `${out:NAME}`.
  - Their values fill part of one file or folder name, so a link can't point it elsewhere.
  - A value with `/`, `\` or `:` is an error before anything runs.
- The block's lines pass the parameters of the runbook called, one `NAME=value` per line. Blank
  lines and `#` comments are allowed.
- Values may use `${param:}`, `${out:}`, `${input:}` and `${secret:}`. A secret is passed as a
  value that is redacted everywhere, never written to either file.
- `section=` runs only the steps under the headings that start with it, as
  `md-runbook run --section` does (repeat it for several). A section that matches no heading of
  the runbook called is an error before anything runs.
- `name=`, `confirm`, `timeout=` (for the whole call), `continue-on-error`, `skip`,
  `kube-context=` and `estimate=` mean what they mean on any block. Options for a shell
  (`cwd=`, `env.NAME=`, `expect=`, `capture=`, `retry=`, …) have no effect on a call; lint says
  so.

## How it runs

- **One step.** The call is done when every selected step of the runbook called is done or
  skipped. It fails when one of them fails, and Run All stops there as for any failed block.
- **Only what is passed.** The runbook called gets the parameters the block passes, nothing
  else: not this runbook's shell variables or session. It runs in a session of its own when its
  front matter says `mode: session`.

  On the command line, nothing is asked. There, a parameter that is not passed and has no
  default is an error before it starts.
- **As a copy.** The runbook called runs as a copy, `<file>.<yyyyMMdd-HHmmss>.md`, next to it
  (`md-runbook run --copy-folder DIR` puts it elsewhere). The file itself stays a clean template.

  The copy holds the outputs. The call's own output says what ran and where:

  ```text
  [md-runbook] ran releases/72512.2611.runbook.md as releases/72512.2611.runbook.20261111-143012.md
  [md-runbook] 6 done, 1 skipped · sha256 3f1c…
  ```

  Its marker records the same as `runbook=`, `copy=`, `steps=` and `sha256=` (the copy's SHA-256
  after the run).
- **The record.** This runbook's `evidence:`, `drill:`, `incident:`, `severity:` and `rto:` are
  written into the copy's front matter too. So its steps are recorded the same way.
- **The report.** Export Report and `md-runbook run --report` show the copy's steps under the
  call (numbered 5.1, 5.2, …), with a link to the copy. They flag a copy whose SHA-256 is no
  longer the one the call recorded (changed after the run).
- **Manual steps.** Task-list items (`- [ ] Check the canary`) in the part called are steps too.
  Unticked, they are listed in the call's result (see [manual steps](cli.md#manual-steps)).
  - In a runbook that keeps evidence, the call is not done until they are ticked in the copy.
    On the command line it fails. Run it again once they are ticked, and it continues in the
    same copy.
  - A `section=` with only manual steps is allowed.
- **Running it again.** A call that failed goes on in the same copy when run again:
  - the steps done there are kept (not run again);
  - the others run;
  - manual steps ticked in the copy since count.

  It goes on only in a run copy of the runbook called, with the same blocks:
  - That copy is named after it, next to it or in the copy folder.
  - For a signed runbook, the copy must carry the same signed name and version.
  - Otherwise a fresh copy runs, and the call's output says why.

  `md-runbook run --fresh-copy` starts a new copy instead. A `${out:NAME}` captured by a step
  done in the earlier run has no value in the next one. Put the capture and its use in the same
  part.
- **The cluster.**
  - If the runbook called names a `kube-context:`, it must be the same as this one's (after
    parameters). Otherwise the call fails before anything runs.
  - If it names none, it runs against this one's, with its `kube-context-mode:`.
- **Safety.** A cycle (A calls B calls A) is an error before anything runs in it. Calls nested
  more than 3 deep and a file that doesn't exist are errors before anything runs too.

## In VS Code

Run the call cell (or Run All): the copy opens beside the runbook, and its steps run there. They
run as you would run them yourself. So you see each one, answer its confirmations and give the
inputs it asks for.

The parameters the call passes are never asked again. The call cell lists each step as it
finishes (`✓ first`, `✗ second (1)`) and ends with the result:

```text
[md-runbook] running releases/72512.2611.runbook.md as releases/72512.2611.runbook.20261111-143012.md
  ✓ Check the release notes
  ✓ Apply the configuration
6 done, 1 skipped · sha256 3f1c…
```

- **Open …** on the cell's status bar opens the copy it ran.
- **Fresh copy** on the cell's status bar runs it in a new copy instead of continuing the failed
  run's copy. So does *md-runbook: Run Runbook Call with a Fresh Copy*.
- Stopping the call cell stops the step running in the copy and the ones after it.
- `mdRunbook.output.copyFolder` puts the copies in another folder, as for Run All as Copy.
- The cell shows how long the call takes: the estimates of what it runs. When `src=` has
  placeholders, it shows *estimate unknown until run*.

## In the app

The md-runbook app (phone and web) runs a call the same way:

1. ▷ on the call (or Run all reaching it) makes the copy and gives it the parameters the call
   passes.
2. The app opens the copy, and its steps run there (the call's sections).
3. When that run ends, the result comes back to the call's step. The app goes back to the
   runbook that called it, where **Resume** goes on after the call.

A call that failed continues in its copy when run again.

Where the app finds the runbook a call names:

- **A runbook opened from a web address**: the address next to it, downloaded the same way. Such
  a runbook comes from a link or QR code with `url=`, or a file on GitHub or GitLab. It must stay
  on the same site (on GitHub and GitLab, in the same repository and version).
- **A runbook opened from a file**: the app asks you once to pick the file the call names. Its
  name must match. The app remembers it while the app is open.

The copy is a runbook of its own in the app's list (`<file>.<yyyyMMdd-HHmmss>.md`).

On a server with md-runbook-gate, the copy's steps run as signed steps of the runbook called.
They are checked against its own signature, like any signed runbook. The gate doesn't know they
were called.

## On the command line

`md-runbook run` follows the call:

- the steps of the runbook called are printed indented and numbered under the call
  (`▶ Step 5.1 · …`);
- `--from`/`--to` count the call as one step;
- `--json`, the JUnit report and the GitHub job summary list its steps after it (`5.1`, `5.2`,
  …). In JUnit, the copy is their class.

```sh
md-runbook run runbooks/3-upgrade.runbook.md --param ENV=DEV --param TO=72512.2611 …
```

## Signed runbooks

Each file has its own signature: the call is signed as written, and the runbook it calls on its
own.

`md-runbook run --allowed-signers FILE` refuses before anything runs when:

- the runbook called is not signed, or changed after it was signed;
- the runbook called is outside the repository;
- a parameter doesn't match its pattern.

See [signed runbooks](signed-runbooks.md#runbook-calls).

## Before it runs

Lint (the editor's problem markers and `md-runbook lint`) reads the runbook a call names when
`src=` has no placeholders:

| Problem | Severity |
|---|---|
| No `src=`, or a body line that isn't `NAME=value` | error |
| `src=` names a file that doesn't exist | error |
| A name in the body the runbook called has no parameter for | error |
| A `section=` that matches no heading of the runbook called | error |
| A `section=` (or `--section`) whose part holds manual steps only: the command line runs none of it | warning |
| A parameter of the runbook called with no default that the call doesn't pass | warning |
| `src=` with placeholders that matches no file yet (`releases/*.runbook.md`) | warning |

`md-runbook estimate` and the run's progress count a call as the estimates of what it runs (its
selected sections). With placeholders in `src=`, its time is unknown until it runs, unless the
block has its own `estimate=`.

## Not in scope

- An include (the other file's text pasted into this one): it would mix two files' signatures,
  outputs and owners. A call keeps each file separately signed, recorded and reviewed.
- Running calls in parallel: blocks of one runbook never run at the same time.

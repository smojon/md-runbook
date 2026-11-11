# Running another runbook as one step

A procedure that is the same every time often wraps a part that changes every time: an upgrade
is always "where am I, the way back is ready, checks green before, deploy, checks green after",
and what each release changes is in its own file. A `runbook` block runs that file as **one
step** of the current runbook:

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
- The block's lines pass the parameters of the runbook called, one `NAME=value` per line. Blank
  lines and `#` comments are allowed. Values may use `${param:}`, `${out:}`, `${input:}` and
  `${secret:}`; a secret is passed as a value that is redacted everywhere, never written to
  either file.
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
  else: not this runbook's shell variables or session (it runs in a session of its own when its
  front matter says `mode: session`). A parameter that is not passed and has no default is an
  error before it starts (on the command line, where nothing is asked).
- **As a copy.** The runbook called runs as a copy, `<file>.<yyyyMMdd-HHmmss>.md`, next to it
  (`md-runbook run --copy-folder DIR` puts it elsewhere). The file itself stays a clean template.
  The copy holds the outputs; the call's own output says what ran and where:

  ```text
  [md-runbook] ran releases/72512.2611.runbook.md as releases/72512.2611.runbook.20261111-143012.md
  [md-runbook] 6 done, 1 skipped · sha256 3f1c…
  ```

  Its marker records the same as `runbook=`, `copy=`, `steps=` and `sha256=` (the copy's SHA-256
  after the run).
- **The record.** `evidence:`, `drill:`, `incident:`, `severity:` and `rto:` of this runbook are
  written into the copy's front matter too, so its steps are recorded the same way.
- **The report.** Export Report and `md-runbook run --report` show the steps of the copy under
  the call, numbered 5.1, 5.2, …, with a link to the copy, and flag a copy whose SHA-256 is no
  longer the one the call recorded (changed after the run).
- **Manual steps.** Task-list items (`- [ ] Check the canary`) in the part called are steps too.
  Unticked, they are listed in the call's result; in a runbook that keeps evidence the call is
  not done until they are ticked in the copy (it fails on the command line; run it again once
  they are, and it continues in the same copy). A `section=` with only manual steps is allowed.
  See [manual steps](cli.md#manual-steps).
- **Running it again.** Running a call that failed again goes on in the same copy: the steps done
  there are kept (not run again), the others run, and manual steps ticked in the copy since count.
  `md-runbook run --fresh-copy` starts a new copy instead. A `${out:NAME}` captured by a step done
  in the earlier run has no value in the next one: put the capture and its use in the same part.
- **The cluster.** If the runbook called names a `kube-context:`, it must be the same as this
  one's (after parameters), or the call fails before anything runs. If it names none, it runs
  against this one's, with its `kube-context-mode:`.
- **Safety.** A cycle (A calls B calls A) and calls nested more than 3 deep are errors before
  anything runs in them, and so is a file that doesn't exist.

## In VS Code

Run the call cell (or Run All): the copy opens beside the runbook and its steps run there, as you
would run them yourself, so you see each one, answer its confirmations and give the inputs it
asks for. The parameters the call passes are never asked again. The call cell lists each step as
it finishes (`✓ first`, `✗ second (1)`) and ends with the result:

```text
[md-runbook] running releases/72512.2611.runbook.md as releases/72512.2611.runbook.20261111-143012.md
  ✓ Check the release notes
  ✓ Apply the configuration
6 done, 1 skipped · sha256 3f1c…
```

- **Open …** on the cell's status bar opens the copy it ran.
- **Fresh copy** on the cell's status bar (or *md-runbook: Run Runbook Call with a Fresh Copy*)
  runs it in a new copy instead of continuing the copy of a failed run.
- Stopping the call cell stops the step running in the copy and the ones after it.
- `mdRunbook.output.copyFolder` puts the copies in another folder, as for Run All as Copy.
- The cell shows how long the call takes (the estimates of what it runs), or *estimate unknown
  until run* when `src=` has placeholders.

The md-runbook app (phone and web) and servers with md-runbook-gate don't run calls yet.

## On the command line

`md-runbook run` follows the call: the steps of the runbook called are printed indented and
numbered under the call (`▶ Step 5.1 · …`), `--from`/`--to` count the call as one step, and
`--json`, the JUnit report and the GitHub job summary list its steps after it (`5.1`, `5.2`,
…; in JUnit with the copy as their class).

```sh
md-runbook run runbooks/3-upgrade.runbook.md --param ENV=DEV --param TO=72512.2611 …
```

## Signed runbooks

A call is signed as written, and the runbook it calls is signed on its own.
`md-runbook run --allowed-signers FILE` refuses before anything runs when the runbook called is
not signed, changed after it was signed, outside the repository, or a parameter doesn't match its
pattern. See [signed runbooks](signed-runbooks.md#runbook-calls).

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
selected sections); with placeholders in `src=`, its time is unknown until it runs, unless the
block has its own `estimate=`.

## Not in scope

- An include, where the other file's text is pasted into this one: it would mix two files'
  signatures, outputs and owners. A call keeps each file separately signed, recorded and reviewed.
- Running calls in parallel: blocks of one runbook never run at the same time.

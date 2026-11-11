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
- **Running it again.** Running a call that failed again goes on in the same copy, from its
  first step not done. `md-runbook run --fresh-copy` starts a new copy instead.
- **The cluster.** If the runbook called names a `kube-context:`, it must be the same as this
  one's (after parameters), or the call fails before anything runs. If it names none, it runs
  against this one's, with its `kube-context-mode:`.
- **Safety.** A cycle (A calls B calls A) and calls nested more than 3 deep are errors before
  anything runs in them, and so is a file that doesn't exist.

## On the command line

`md-runbook run` follows the call: the steps of the runbook called are printed indented and
numbered under the call (`▶ Step 5.1 · …`), `--from`/`--to` count the call as one step, and
`--json`, the JUnit report and the GitHub job summary list its steps after it (`5.1`, `5.2`,
…; in JUnit with the copy as their class).

```sh
md-runbook run runbooks/3-upgrade.runbook.md --param ENV=DEV --param TO=72512.2611 …
```

## Before it runs

Lint (the editor's problem markers and `md-runbook lint`) reads the runbook a call names when
`src=` has no placeholders:

| Problem | Severity |
|---|---|
| No `src=`, or a body line that isn't `NAME=value` | error |
| `src=` names a file that doesn't exist | error |
| A name in the body the runbook called has no parameter for | error |
| A `section=` that matches no heading of the runbook called | error |
| A parameter of the runbook called with no default that the call doesn't pass | warning |
| `src=` with placeholders that matches no file yet (`releases/*.runbook.md`) | warning |

`md-runbook estimate` and the run's progress count a call as the estimates of what it runs (its
selected sections); with placeholders in `src=`, its time is unknown until it runs, unless the
block has its own `estimate=`.

## Not in scope

- An include, where the other file's text is pasted into this one: it would mix two files'
  signatures, outputs and owners. A call keeps each file separately signed, recorded and reviewed.
- Running calls in parallel: blocks of one runbook never run at the same time.

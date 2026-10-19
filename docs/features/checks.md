# Checks, retries and captured values

Three groups of [cell options](safety.md#cell-options) make a runbook check its own results,
wait for things to become ready, and pass values from one step to the next.

To try them, open [`examples/sample.runbook.md`](../../examples/sample.runbook.md) (sections 14 and
15) or run **md-runbook: Open Sample Runbook**.

## Checks: `expect=`

By default a cell passes when it exits with code 0. Checks add conditions on its output:

````markdown
```bash expect="1/1     Running"
kubectl get pods -l app=web
```

```pwsh expect=/^Status\s+:\s+Running$/m expect-not="Exception"
Get-Service w32time | Format-List Status
```

```bash expect-exit=1 expect="not found"
grep -q old-setting config.yaml || echo "not found"; exit 1
```
````

| Option | Passes when |
|---|---|
| `expect="text"` | the output contains the text (exact, case-sensitive) |
| `expect=/regex/flags` | the output matches the regular expression (flags `i`, `m`, `s`, `u`) |
| `expect-not="text"` or `expect-not=/regex/` | the output does **not** contain / match it |
| `expect-exit=N` | the exit code is N instead of 0 |

- The output checked is everything the cell printed (stdout and stderr), without colour codes,
  with `\n` line endings.
- Quote values that contain spaces: `expect="pod Running"`, `expect="/a b/"`. Use single quotes
  around a value that contains `"`.
- A failed check fails the cell even with exit code 0. The output ends with the reason, e.g.
  `[md-runbook] check failed: the output does not contain "Running"`, and the marker gets
  `check=failed` (`check=ok` when every check passed). Progress, Resume Run, Run All
  (stop on failure) and the report follow `check=` rather than the exit code, so
  `expect-exit=1` with exit code 1 counts as done.

## Retries: `retry=`

````markdown
```bash retry=20 every=15s expect="successfully rolled out"
kubectl rollout status deploy/web --timeout=10s
```
````

- `retry=N` runs the cell **up to N times in all** until it passes (exit code, plus the checks
  above). `every=` sets the wait between attempts: `15s`, `500ms`, `2m`, or a number of seconds.
  The default is 5 seconds.
- While it runs you see the current attempt live, and why the previous one failed. Only the
  **last attempt's output** is kept and saved. The status line shows `attempt 4/20`, and the
  marker gets `attempts=4`.
- A timed-out attempt is tried again; cancelling stops at once. The timeout applies to each
  attempt.

## Captured values: `capture=` and `${out:NAME}`

A cell can keep part of its output for later cells, without session mode:

````markdown
```bash capture="POD:/^(web-\S+)/m"
kubectl get pods -l app=web -o name | sed 's|pod/||'
```

```bash
kubectl logs "${out:POD}" --tail=20
```
````

| Option | Captures |
|---|---|
| `capture=NAME` | the whole standard output, trimmed |
| `capture=NAME:/regex/` | the first group of the first match in standard output (or the whole match without a group) |
| `capture-secret=NAME` (also with `:/regex/`) | the same, as a secret |

- Only **standard output** is read, and only when the cell passed. If nothing matches, the cell
  fails with `capture NAME: nothing in the output matches …`, so `retry=` can wait for a value
  to appear.
- `${out:NAME}` works like the [other placeholders](secrets.md): the value is passed as an
  environment variable, never pasted into the script, and the file keeps the placeholder.
  Values are kept until the runbook is closed or **Reset Inputs** is run. A cell that uses
  `${out:NAME}` before any cell captured it fails with
  `${out:NAME} has no value yet; run the cell with capture=NAME first`.
- **`capture-secret=`** values are redacted: from the capturing cell's own output (it is redrawn
  once the value is known), from every later output, and from the saved file. They are never
  written to disk. Like other secrets, values shorter than 4 characters are not redacted. Cells
  written by an assistant can't use them.

## Limits

- Checks, retries and captures apply when the whole cell runs in the runbook view, including
  cells with the `terminal` option. [Line runs](lines.md) (Run Line or Selection, Run Lines One
  by One, Step Through) and the plain text editor's ▶ Run CodeLens ignore them.

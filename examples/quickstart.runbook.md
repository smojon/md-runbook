---
title: Deploy the demo app
params:
  - ENVIRONMENT: staging
---

# Deploy the demo app

A short tour: six steps, under a minute. Nothing here changes your machine: the steps print
text, sleep, and use one file in the temp folder. Press **Run All** and watch the **Steps** view
on the left: before the run it says what the steps will need from you, during the run where it
is and how long is left.

Each step has a block for Windows (PowerShell) and one for macOS and Linux (bash); only yours
runs.

## Check the tools

```pwsh os=windows estimate=3s
Write-Output "Deploying to ${param:ENVIRONMENT}"
Start-Sleep -Seconds 2
Write-Output "tools ok"
```

```bash os=linux,macos estimate=3s
echo "Deploying to ${param:ENVIRONMENT}"
sleep 2
echo "tools ok"
```

## Build the image

```pwsh os=windows estimate=10s
Start-Sleep -Seconds 8
Write-Output "built demo:1.0"
```

```bash os=linux,macos estimate=10s
sleep 8
echo "built demo:1.0"
```

## Roll out

This one asks before it runs (`confirm`), as a risky command would.

```pwsh os=windows confirm estimate=5s
Write-Output "rolling out demo:1.0 to ${param:ENVIRONMENT} (pretend)"
Start-Sleep -Seconds 4
Write-Output "rolled out"
```

```bash os=linux,macos confirm estimate=5s
echo "rolling out demo:1.0 to ${param:ENVIRONMENT} (pretend)"
sleep 4
echo "rolled out"
```

## Tell the team

- [ ] Post "demo is out" in the team channel

A step done by hand: Run All waits here, with **Done**, **Skip** and **Stop** on the cell.

## Smoke test

It fails the first time, to show what happens then: **Retry** on the cell, or **Resume** in the
Steps view, runs it again and it passes.

```pwsh os=windows estimate=3s
$f = Join-Path ([IO.Path]::GetTempPath()) 'md-runbook-demo-smoke'
if (Test-Path $f) { Remove-Item $f; Write-Output 'smoke test passed' }
else { New-Item -ItemType File $f | Out-Null; [Console]::Error.WriteLine("the app isn't ready yet: Retry it"); exit 1 }
```

```bash os=linux,macos estimate=3s
f="${TMPDIR:-/tmp}/md-runbook-demo-smoke"
if [ -f "$f" ]; then rm "$f"; echo "smoke test passed"
else touch "$f"; echo "the app isn't ready yet: Retry it" >&2; exit 1; fi
```

## Clean up

The teardown: offered at the end (**Take Down** or **Leave It Up**), not run by itself.

```pwsh os=windows teardown estimate=2s
Write-Output "removing the demo from ${param:ENVIRONMENT} (pretend)"
```

```bash os=linux,macos teardown estimate=2s
echo "removing the demo from ${param:ENVIRONMENT} (pretend)"
```

That's it. **Open Feature Tour** shows everything else, one section per feature.

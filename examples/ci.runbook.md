---
params:
  - GREETING: hello
timeout: 120
---

# CI smoke runbook

This repository's CI runs this file with the md-runbook command line on Windows, macOS and
Linux (through the GitHub Action in `action.yml`), and keeps the filled-in copy, the HTML and PDF
reports and a JUnit report as build artifacts. It only prints text and uses a temporary file.

## Where are we

```pwsh os=windows
Write-Output "OS: Windows, PowerShell $($PSVersionTable.PSVersion)"
```

```bash os=linux,macos
echo "OS: $(uname -s), bash $BASH_VERSION"
```

cmd only exists on Windows:

```cmd os=windows
echo cmd works
```

## Checks and captured values

```bash expect="user:" capture="WHO:/^user: (\S+)/m"
echo "user: $(whoami | tr -d '\r' | tr '\\' '/')"
```

```pwsh expect="/^hello, \S+$/m"
Write-Output "${param:GREETING}, ${out:WHO}"
```

## Waiting until something is ready

Passes on the second attempt:

```bash retry=3 every=1s
f="${TMPDIR:-/tmp}/md-runbook-ci-retry-${PPID}"
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"
echo "attempt $n"
if [ "$n" -lt 2 ]; then exit 1; fi
rm -f "$f"
```

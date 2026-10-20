# Every second: the throwaway VS Code's processes (from .vscode-test) with priority class, base
# priority and CPU seconds, plus the machine's total CPU load. Runs until $Seconds have passed.
param([string]$Out, [int]$Seconds = 900)
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $t = (Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
  $procs = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*md-runbook\.vscode-test\*' }
  foreach ($p in $procs) {
    try { "$t pid=$($p.Id) class=$($p.PriorityClass) base=$($p.BasePriority) cpu=$([math]::Round($p.CPU,2))" | Out-File -Append -Encoding utf8 $Out } catch {}
  }
  Start-Sleep -Milliseconds 1000
}

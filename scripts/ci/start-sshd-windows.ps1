# Starts a throwaway OpenSSH server for the @md-runbook/ssh Windows tests on 127.0.0.1:2222, as
# scripts/ci/start-sshd.sh does on Linux and macOS: its own host key ($env:RUNNER_TEMP\sshd\
# host_ecdsa.pub is the key to pin) and an empty authorized_keys (the tests add the key they
# make). Windows CI runners only (it installs the OpenSSH Server feature if it is missing).
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:RUNNER_TEMP 'sshd'
New-Item -ItemType Directory -Force $d | Out-Null
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
if (-not (Test-Path $sshd)) {
  Write-Host 'Installing the OpenSSH Server feature...'
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
$key = Join-Path $d 'host_ecdsa'
# PowerShell 7 passes '' as an empty argument (the CI step runs in pwsh).
& $keygen -q -t ecdsa -b 256 -N '' -f $key
if ($LASTEXITCODE) { throw 'ssh-keygen failed' }
$auth = Join-Path $d 'authorized_keys'
Set-Content -Path $auth -Value $null -Encoding ascii
# sshd refuses key files that others can read: only this user, SYSTEM and Administrators.
foreach ($f in @($key, $auth)) {
  icacls $f /inheritance:r /grant:r "$($env:USERNAME):F" 'SYSTEM:F' 'Administrators:F' | Out-Null
}
$config = Join-Path $d 'sshd_config'
@(
  'Port 2222',
  'ListenAddress 127.0.0.1',
  "HostKey $($key -replace '\\', '/')",
  "AuthorizedKeysFile $($auth -replace '\\', '/')",
  'PasswordAuthentication no',
  'KbdInteractiveAuthentication no',
  'StrictModes no'
) | Set-Content -Path $config -Encoding ascii
$log = Join-Path $d 'sshd.log'
# Config errors first: the service only says it failed.
& $sshd -t -f $config
if ($LASTEXITCODE) { throw "sshd -t: the config is not valid ($config)" }
# The Windows service, with this config: logins as the runner's user, through cmd.exe (the default
# shell). Its command line set in the registry (sc.exe's quoting rules mangle quoted paths).
Stop-Service sshd -ErrorAction SilentlyContinue
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\sshd' -Name ImagePath -Value "`"$sshd`" -f `"$config`" -E `"$log`""
try {
  Start-Service sshd
} catch {
  Write-Host "sshd did not start: $_"
  if (Test-Path $log) { Get-Content $log }
  Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 20 -ErrorAction SilentlyContinue | Format-List TimeCreated, Message
  exit 1
}
for ($i = 0; $i -lt 20; $i++) {
  if ((Test-NetConnection 127.0.0.1 -Port 2222 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    Write-Host 'sshd is listening on 127.0.0.1:2222'
    exit 0
  }
  Start-Sleep -Seconds 1
}
Write-Host 'sshd did not start:'
if (Test-Path $log) { Get-Content $log }
exit 1

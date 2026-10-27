/**
 * What is sent to the remote shell. Pure functions, so they can be tested without a server.
 *
 * A cell travels as a quoted here-doc with a random terminator (the cell's text can't end it), is
 * written to a temp file and sourced in the shell, so `cd` and variables carry over to the next
 * cell, as in a local session (core/node/session.ts). Then the end-of-cell marker
 * `<RS>__MDRB_<id>__ <exit>` is printed on stderr and on stdout: both, because the two streams
 * reach us separately and stderr could otherwise still be on its way when stdout ends.
 */

import type { UnixShell } from '@md-runbook/core';
import { Buffer } from 'buffer';

/** Started by the `exec` request: bash as a login shell (for the user's PATH), else sh. */
export const SHELL_COMMAND = 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l';

/**
 * The `exec` request for the runbook's `shell:` (a login shell too). zsh falls back to sh when the
 * server has none, so the connection still answers; `shellProbeCommand` then tells.
 */
export function posixShellCommand(unix: UnixShell | undefined): string {
  if (unix === 'zsh') return 'command -v zsh >/dev/null 2>&1 && exec zsh -l || exec sh -l';
  if (unix === 'sh') return 'exec sh -l';
  return SHELL_COMMAND;
}

/** Which shell answers, by the shell's own variables: the marker's value is an index in PROBED_SHELLS. */
export function shellProbeCommand(id: string): string {
  return (
    '__mdrb_sh=0; if [ -n "$ZSH_VERSION" ]; then __mdrb_sh=2; elif [ -n "$BASH_VERSION" ]; then __mdrb_sh=1; fi; ' +
    printMarker(markerFor(id), '"$__mdrb_sh"')
  );
}
export const PROBED_SHELLS: readonly UnixShell[] = ['sh', 'bash', 'zsh'];

export const markerFor = (id: string): string => `__MDRB_${id}__`;

/** POSIX single quotes. */
export const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const printMarker = (marker: string, value: string): string =>
  `printf '\\036%s %s\\n' ${marker} ${value} >&2; printf '\\036%s %s\\n' ${marker} ${value}\n`;

/**
 * First line sent: reports the shell's process id (for cancelling) as its marker value. A plain
 * shell runs it as is (`:` does nothing); md-runbook-gate recognizes it and answers with its
 * banner first (`gateBanner`).
 */
export function helloCommand(id: string): string {
  return `: mdrb-gate-hello ${id}; ` + printMarker(markerFor(id), '"$$"');
}

/** What md-runbook-gate said about itself in its answer to the hello. */
export interface GateInfo {
  protocol: number;
  /** Whether this server (for this key) runs cells that are not signed. */
  unsigned: 'allow' | 'refuse';
}

/** The gate's banner in the output before the hello's marker; undefined for a plain shell. */
export function gateBanner(output: string): GateInfo | undefined {
  const m = /\x1e__MDRB_GATE__ (\d+) unsigned=(allow|refuse)\n/.exec(output);
  return m ? { protocol: Number(m[1]), unsigned: m[2] as 'allow' | 'refuse' } : undefined;
}

/** The gate's answer to a load: the principal whose signature it accepted, and the manifest's sha256. */
export function signedReply(output: string): { principal: string; hash: string } | undefined {
  const m = /\x1e__MDRB_SIGNED__ (\S+) ([0-9a-f]{64})\n/.exec(output);
  return m ? { principal: m[1]!, hash: m[2]! } : undefined;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Gate requests (one line each; see apps/gate/md-runbook-gate). `signature` is the SSHSIG blob, base64. */
/** `signatures`: every signature of the manifest (author, co-signers); a server may need several signers. */
export const gateLoadCommand = (id: string, manifest: string, signatures: string | readonly string[]): string =>
  `load ${id} ${b64(manifest)} ${(typeof signatures === 'string' ? [signatures] : signatures).join(' ')}\n`;
export const gateParamCommand = (id: string, name: string, value: string): string => `param ${id} ${name} ${b64(value)}\n`;
export const gateRunCommand = (id: string, cell: number, step?: number): string =>
  step === undefined ? `run ${id} ${Math.trunc(cell)}\n` : `step ${id} ${Math.trunc(cell)} ${Math.trunc(step)}\n`;
/** An unsigned cell, for a gate that allows them: the text a plain shell would get. */
export const gateRawCommand = (id: string, text: string): string => `raw ${id} ${b64(text)}\n`;
/** `kubectl config current-context` in the gate's shell, signed runbooks only or not (the kube-context guard). */
export const gateContextCommand = (id: string): string => `context ${id}\n`;

export interface CellCommandOptions {
  /** Exported before the cell runs (and kept for later cells, as in a local session). */
  env?: Record<string, string>;
  /** Runs the cell in this folder, then goes back to the folder the session was in. */
  cwd?: string;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The text sent to the shell for one cell. Values in `env` go through the channel only, never
 * to the remote disk (the temp file holds the cell's text, which has placeholders, not secrets).
 */
export function cellCommand(source: string, id: string, opts: CellCommandOptions = {}): string {
  const marker = markerFor(id);
  const eof = `__MDRB_EOF_${id}`;
  const body = source.endsWith('\n') ? source : source + '\n';
  const exportLines = Object.entries(opts.env ?? {})
    .filter(([k]) => VAR_NAME.test(k))
    .map(([k, v]) => `export ${k}=${sq(v)}\n`)
    .join('');
  // stdin is the command stream, so the cell reads from /dev/null like an isolated run.
  const run = '. "$__mdrb_f" </dev/null; __mdrb_rc=$?';
  const runIn =
    opts.cwd === undefined
      ? `${run}; `
      : `__mdrb_cd=$PWD; if cd -- ${sq(opts.cwd)}; then ${run}; cd -- "$__mdrb_cd" 2>/dev/null; else __mdrb_rc=1; fi; `;
  return (
    `__mdrb_f=$(mktemp) && cat > "$__mdrb_f" <<'${eof}'\n${body}${eof}\n` +
    exportLines +
    runIn +
    'rm -f "$__mdrb_f"; ' +
    printMarker(marker, '"$__mdrb_rc"')
  );
}

/**
 * Command for a second channel that stops the cell running in the shell `pid` without ending
 * the shell: it signals the shell's children (the cell's commands), so the shell prints the
 * marker and keeps its folder and variables.
 */
export function stopCommand(pid: number, signal: 'TERM' | 'KILL'): string {
  return `pkill -${signal} -P ${Math.trunc(pid)} 2>/dev/null; true`;
}

// ---- Windows servers ----
//
// OpenSSH on Windows runs an exec request through cmd.exe (or PowerShell, if that is its default
// shell), where SHELL_COMMAND fails at once. The app then starts Windows PowerShell reading
// commands on stdin, as the extension's PowerShell sessions do (core/node/session.ts): each
// command is one ASCII line, the cell travels in base64 and is written to a temp script that is
// dot-sourced, so variables, functions and the folder carry over. cmd cells run from there in a
// cmd.exe of their own (cmd has no session mode, as in the extension).

/** Which kind of shell the server gave: sh/bash on Linux and macOS, Windows PowerShell on Windows. */
export type RemotePlatform = 'posix' | 'windows';

/** Started by the `exec` request on a Windows server. */
export const WINDOWS_SHELL_COMMAND = 'powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -';
/** The same with PowerShell 7, for a runbook with `shell: pwsh`. */
export const PWSH_SHELL_COMMAND = 'pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -';

/** PowerShell single quotes (it also treats the typographic ones as quotes). */
export const psq = (s: string): string => "'" + s.replace(/['‘’‚‛]/g, (q) => q + q) + "'";

/** A string expression whose value is `s`, written in ASCII (the command stream's encoding varies on Windows). */
const ps64 = (s: string): string => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

const psMarker = (marker: string, value: string): string =>
  `$__mdrbS = [string][char]30 + '${marker} ' + ${value} + [char]10; [Console]::Out.Write($__mdrbS); [Console]::Error.Write($__mdrbS)\n`;

/** First lines on Windows: UTF-8 output, no progress bars, then the marker with the shell's process id. */
export function windowsHelloCommand(id: string): string {
  return (
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = New-Object Text.UTF8Encoding $false; $ProgressPreference = 'SilentlyContinue'\n" +
    psMarker(markerFor(id), '$PID')
  );
}

/**
 * The text sent to Windows PowerShell for one `pwsh`/`powershell` or `cmd` cell. Two lines: a
 * terminating error ends only the first, and the exit code follows the extension's rules (the
 * last native exit code, else 1 if the script failed). Values in `env` are set from the command
 * stream, never written to disk; the temp script holds the cell's text (placeholders, not values).
 */
export function windowsCellCommand(source: string, id: string, kind: 'pwsh' | 'cmd', opts: CellCommandOptions = {}): string {
  const ext = kind === 'cmd' ? '.cmd' : '.ps1';
  // A cmd script gets CRLF and UTF-8; a PowerShell script a BOM, so Windows PowerShell reads it as UTF-8.
  const script = kind === 'cmd' ? ['@echo off', '@chcp 65001 >nul', ...source.split(/\r?\n/)].join('\r\n') + '\r\n' : source;
  const encoding = kind === 'cmd' ? '(New-Object Text.UTF8Encoding $false)' : '(New-Object Text.UTF8Encoding $true)';
  const env = Object.entries(opts.env ?? {})
    .filter(([k]) => VAR_NAME.test(k))
    .map(([k, v]) => `[Environment]::SetEnvironmentVariable(${psq(k)}, ${ps64(v)}); `)
    .join('');
  const cd = opts.cwd === undefined ? '' : `Push-Location -LiteralPath (${ps64(opts.cwd)}) -StackName mdrb -ErrorAction Stop; $__mdrbPushed = $true; `;
  const run = kind === 'cmd' ? '& $env:ComSpec /d /c $__mdrbF' : '. $__mdrbF';
  return (
    `$global:LASTEXITCODE = 0; $__mdrbOk = $false; $__mdrbPushed = $false; ` +
    `$__mdrbF = Join-Path ([IO.Path]::GetTempPath()) 'mdrb-${id}${ext}'; ` +
    `[IO.File]::WriteAllText($__mdrbF, ${ps64(script)}, ${encoding}); ` +
    `${env}${cd}${run}; $__mdrbOk = $?\n` +
    `Remove-Item -LiteralPath $__mdrbF -Force -ErrorAction Ignore; ` +
    `if ($__mdrbPushed) { Pop-Location -StackName mdrb -ErrorAction Ignore; $__mdrbPushed = $false }; ` +
    `$__mdrbRc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $__mdrbOk) { 1 } else { 0 }; ` +
    psMarker(markerFor(id), '$__mdrbRc')
  );
}

/**
 * Windows: stop the cell running in PowerShell `pid` (the programs it started, with their own
 * children), keeping the shell. A cell that loops in PowerShell itself can't be stopped this way;
 * the caller then closes the shell.
 */
export function windowsStopCommand(pid: number): string {
  return (
    `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.trunc(pid)}' | ` +
    `Where-Object { $_.Name -ne 'conhost.exe' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }"`
  );
}

/** A random id for markers and here-doc terminators (Web Crypto: Node 20+, browsers, React Native polyfill). */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Install My Key: append `line` (the app's `ecdsa-sha2-nistp256 AAAA… md-runbook-app`) to the
 * account's ~/.ssh/authorized_keys, once. Creates ~/.ssh (700) and the file (600) when missing,
 * adds the missing newline at the end of a file before appending, and says which happened:
 * `__MDRB_KEY_ADDED__` or `__MDRB_KEY_ALREADY__`. POSIX sh; nothing else is changed.
 */
export function installKeyCommand(line: string): string {
  const key = sq(line.trim());
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    'f="$HOME/.ssh/authorized_keys"',
    'touch "$f" && chmod 600 "$f"',
    `if grep -qxF ${key} "$f"; then echo __MDRB_KEY_ALREADY__; else`,
    '  if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l)" -eq 0 ]; then printf "\\n" >>"$f"; fi',
    `  printf '%s\\n' ${key} >>"$f" && echo __MDRB_KEY_ADDED__`,
    'fi',
  ].join('\n');
}

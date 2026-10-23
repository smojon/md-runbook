/**
 * Shell selection per fence language. Pure given a `ShellEnv`, so it can be tested for every
 * platform from any platform (but it uses Node's path functions for Windows paths).
 */

import * as path from 'node:path';
import type { ResolvedShell, ShellEnv, ShellKind, ShellResolution, ShellSettings } from '../shellKind';

export type { ResolvedShell, ShellEnv, ShellKind, ShellResolution, ShellSettings } from '../shellKind';
export { shellKindForLanguage } from '../shellKind';

export function resolveShell(kind: ShellKind, settings: ShellSettings, env: ShellEnv): ShellResolution {
  switch (kind) {
    case 'pwsh':
      return resolvePwsh(settings, env);
    case 'cmd':
      return resolveCmd(env);
    case 'bash':
      return resolveBash(settings, env);
  }
}

/** Windows PowerShell 5.1, the one that comes with Windows. */
function windowsPowerShell(env: ShellEnv): string | undefined {
  const systemRoot = env.env.SystemRoot ?? env.env.SYSTEMROOT ?? 'C:\\Windows';
  const builtin = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return env.which('powershell.exe') ?? (env.exists(builtin) ? builtin : undefined);
}

function resolvePwsh(settings: ShellSettings, env: ShellEnv): ShellResolution {
  const win = env.platform === 'win32';
  const wanted = settings.runbook?.powershell;
  let command: string | undefined;
  if (wanted === 'windows-powershell') {
    if (!win) return { ok: false, error: "Windows PowerShell 5.1 runs only on Windows (the runbook's shell: windows-powershell)." };
    command = windowsPowerShell(env);
    if (!command) return { ok: false, error: "Windows PowerShell 5.1 not found (the runbook's shell: windows-powershell)." };
  } else {
    command = settings.pwshPath?.trim() || env.which('pwsh');
    // Without a choice, Windows PowerShell stands in for PowerShell 7; `shell: pwsh` needs 7.
    if (!command && wanted === 'pwsh') {
      return { ok: false, error: "PowerShell 7 (pwsh) not found (the runbook's shell: pwsh): install it or set mdRunbook.shell.pwshPath." };
    }
    if (!command && win) command = windowsPowerShell(env);
    if (!command) command = env.which('powershell');
  }
  if (!command) {
    return { ok: false, error: 'PowerShell not found: install PowerShell 7 (pwsh) or set mdRunbook.shell.pwshPath.' };
  }
  const label = /powershell(\.exe)?$/i.test(command) ? 'powershell' : 'pwsh';
  return {
    ok: true,
    shell: {
      kind: 'pwsh',
      command,
      label,
      extension: '.ps1',
      args: (scriptPath) => [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        ...(win ? ['-ExecutionPolicy', 'Bypass'] : []),
        '-Command',
        pwshWrapper(scriptPath),
      ],
      // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII source correctly.
      script: (source) => '\uFEFF' + source.replace(/\r?\n/g, win ? '\r\n' : '\n') + (win ? '\r\n' : '\n'),
    },
  };
}

/**
 * Run the script in a wrapper that forces UTF-8 output and turns failure into a non-zero exit
 * code: the last native command's exit code, or 1 if the script ended in an error.
 */
export function pwshWrapper(scriptPath: string): string {
  // PowerShell also treats the typographic single quotes as quote characters.
  const quoted = "'" + scriptPath.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q) + "'";
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    '$global:LASTEXITCODE = 0',
    `& ${quoted}`,
    '$mdRunbookOk = $?',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $mdRunbookOk) { exit 1 } else { exit 0 }',
  ].join('; ');
}

function resolveCmd(env: ShellEnv): ShellResolution {
  if (env.platform !== 'win32') return { ok: false, error: 'cmd blocks can only run on Windows.' };
  const systemRoot = env.env.SystemRoot ?? env.env.SYSTEMROOT ?? 'C:\\Windows';
  const command = env.env.ComSpec ?? env.env.COMSPEC ?? path.win32.join(systemRoot, 'System32', 'cmd.exe');
  return {
    ok: true,
    shell: {
      kind: 'cmd',
      command,
      label: 'cmd',
      extension: '.cmd',
      // /s strips the outer quotes, leaving the quoted script path intact even with spaces.
      args: (scriptPath) => ['/d', '/s', '/c', `""${scriptPath}""`],
      windowsVerbatimArguments: true,
      // Batch files need CRLF; switch to UTF-8 and hide command echo like an interactive prompt.
      script: (source) => ['@echo off', '@chcp 65001 >nul', ...source.split(/\r?\n/)].join('\r\n') + '\r\n',
    },
  };
}

/** Candidate Git Bash locations on Windows, most likely first. */
export function gitBashCandidates(env: ShellEnv): string[] {
  const w = path.win32;
  const out: string[] = [];
  for (const base of [env.env.ProgramFiles, env.env.ProgramW6432, env.env['ProgramFiles(x86)']]) {
    if (base) out.push(w.join(base, 'Git', 'bin', 'bash.exe'));
  }
  if (env.env.LOCALAPPDATA) out.push(w.join(env.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  if (env.env.USERPROFILE) out.push(w.join(env.env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'));
  const git = env.which('git.exe') ?? env.which('git');
  if (git) {
    // <Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe -> <Git>\bin\bash.exe
    const dir = w.dirname(git);
    out.push(w.join(dir, '..', 'bin', 'bash.exe'), w.join(dir, '..', '..', 'bin', 'bash.exe'));
  }
  return [...new Set(out.map((p) => w.normalize(p)))];
}

/** WSL's launcher, which must not be mistaken for Git Bash. */
function isWslBash(p: string): boolean {
  return /\\(System32|Sysnative)\\bash\.exe$/i.test(p) || /\\WindowsApps\\/i.test(p);
}

/** A Windows executable on PATH that isn't WSL's launcher (WSL's shells run in Linux, not here). */
function windowsOnPath(env: ShellEnv, name: string): string | undefined {
  const p = env.which(name);
  return p && !isWslBash(p) ? p : undefined;
}

/** bash, zsh or sh running the cell's script file. */
const unixShell = (command: string, label: string, win: boolean): ResolvedShell => ({
  kind: 'bash',
  command,
  label,
  extension: '.sh',
  // Git Bash accepts C:/x/y paths; backslashes would be eaten as escapes in some contexts.
  args: (scriptPath: string) => [win ? scriptPath.replace(/\\/g, '/') : scriptPath],
  script: (source: string) => source.replace(/\r\n/g, '\n') + '\n',
});

/** `shell: zsh` or `shell: sh`: that shell for the runbook's sh/bash cells, found by name. */
function resolveNamedUnix(name: 'zsh' | 'sh', env: ShellEnv): ShellResolution {
  const win = env.platform === 'win32';
  let command: string | undefined;
  if (name === 'zsh') command = win ? windowsOnPath(env, 'zsh.exe') : env.which('zsh');
  else if (!win) command = env.exists('/bin/sh') ? '/bin/sh' : env.which('sh');
  else {
    // Git for Windows has sh.exe next to bash.exe (bash in POSIX mode).
    command = gitBashCandidates(env)
      .map((p) => path.win32.join(path.win32.dirname(p), 'sh.exe'))
      .find((p) => env.exists(p));
    command ??= windowsOnPath(env, 'sh.exe');
  }
  if (!command) {
    const where = win && name === 'sh' ? ': install Git for Windows' : win ? ' on PATH (WSL\'s is not used)' : ' on PATH';
    return { ok: false, error: `${name} not found${where} (the runbook's shell: ${name}).` };
  }
  return { ok: true, shell: unixShell(command, name, win) };
}

function resolveBash(settings: ShellSettings, env: ShellEnv): ShellResolution {
  const named = settings.runbook?.unix;
  if (named === 'zsh' || named === 'sh') return resolveNamedUnix(named, env);
  const win = env.platform === 'win32';
  let command = settings.bashPath?.trim() || undefined;
  if (!command && win) {
    command = gitBashCandidates(env).find((p) => env.exists(p));
    if (!command) {
      const onPath = env.which('bash.exe');
      if (onPath && !isWslBash(onPath)) command = onPath;
    }
    if (!command) {
      return {
        ok: false,
        error: 'Git Bash not found: install Git for Windows or set mdRunbook.shell.bashPath to bash.exe.',
      };
    }
  }
  // Without a choice, sh stands in for a missing bash; `shell: bash` needs bash.
  if (!command) command = env.which('bash') ?? (named === 'bash' ? undefined : env.which('sh'));
  if (!command) {
    return { ok: false, error: `bash not found on PATH${named === 'bash' ? " (the runbook's shell: bash)" : ''}: set mdRunbook.shell.bashPath.` };
  }
  return { ok: true, shell: unixShell(command, /(^|[\\/])sh$/.test(command) ? 'sh' : 'bash', win) };
}

/**
 * Shell selection per fence language. Pure given a `ShellEnv`, so it can be tested for every
 * platform from any platform (but it uses Node's path functions for Windows paths).
 */

import * as path from 'node:path';
import type { ShellEnv, ShellKind, ShellResolution, ShellSettings } from '../shellKind';

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

function resolvePwsh(settings: ShellSettings, env: ShellEnv): ShellResolution {
  const win = env.platform === 'win32';
  let command = settings.pwshPath?.trim() || env.which('pwsh');
  if (!command && win) {
    const systemRoot = env.env.SystemRoot ?? env.env.SYSTEMROOT ?? 'C:\\Windows';
    const builtin = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    command = env.which('powershell.exe') ?? (env.exists(builtin) ? builtin : undefined);
  }
  if (!command) command = env.which('powershell');
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

function resolveBash(settings: ShellSettings, env: ShellEnv): ShellResolution {
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
  if (!command) command = env.which('bash') ?? env.which('sh');
  if (!command) return { ok: false, error: 'bash not found on PATH: set mdRunbook.shell.bashPath.' };
  return {
    ok: true,
    shell: {
      kind: 'bash',
      command,
      label: /(^|[\\/])sh$/.test(command) ? 'sh' : 'bash',
      extension: '.sh',
      // Git Bash accepts C:/x/y paths; backslashes would be eaten as escapes in some contexts.
      args: (scriptPath) => [win ? scriptPath.replace(/\\/g, '/') : scriptPath],
      script: (source) => source.replace(/\r\n/g, '\n') + '\n',
    },
  };
}

/**
 * Shell kinds per fence language, and the types shell resolution (node/shell.ts) works with.
 * Platform-neutral: the app uses these too.
 */

export type ShellKind = 'bash' | 'pwsh' | 'cmd';

export function shellKindForLanguage(lang: string): ShellKind | undefined {
  switch (lang.toLowerCase()) {
    case 'sh':
    case 'bash':
    case 'shellscript':
      return 'bash';
    case 'pwsh':
    case 'powershell':
      return 'pwsh';
    case 'cmd':
    case 'bat':
      return 'cmd';
    default:
      return undefined;
  }
}

/** Shells a runbook can ask for by name (front matter `shell:`), for its sh/bash cells. */
export const UNIX_SHELLS = ['bash', 'zsh', 'sh'] as const;
export type UnixShell = (typeof UNIX_SHELLS)[number];
/** ...and for its pwsh/powershell cells: PowerShell 7, or Windows PowerShell 5.1. */
export const POWERSHELLS = ['pwsh', 'windows-powershell'] as const;
export type PowerShellName = (typeof POWERSHELLS)[number];

/**
 * The front matter's `shell:`: which installed shell runs the runbook's cells. Only names from
 * the lists above, never a path, so a runbook can't make you run a program it brought along.
 */
export interface RunbookShells {
  unix?: UnixShell;
  powershell?: PowerShellName;
}

/**
 * `shell:`'s value: names separated by commas or spaces (`zsh, windows-powershell`), optionally
 * in YAML brackets, at most one of each list. `unknown`: names not in the lists; `twice`: a
 * second name for the same cells (the first one counts).
 */
export function parseShells(value: string): { shells: RunbookShells; unknown: string[]; twice: string[] } {
  const shells: RunbookShells = {};
  const unknown: string[] = [];
  const twice: string[] = [];
  const names = value
    .replace(/^\s*\[|\]\s*$/g, '')
    .split(/[\s,]+/)
    .map((n) => n.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const raw of names) {
    const name = raw.toLowerCase();
    if ((UNIX_SHELLS as readonly string[]).includes(name)) {
      if (shells.unix) twice.push(raw);
      else shells.unix = name as UnixShell;
    } else if ((POWERSHELLS as readonly string[]).includes(name)) {
      if (shells.powershell) twice.push(raw);
      else shells.powershell = name as PowerShellName;
    } else unknown.push(raw);
  }
  return { shells, unknown, twice };
}

export interface ShellSettings {
  /** Explicit bash executable (e.g. Git Bash on Windows). */
  bashPath?: string;
  /** Explicit PowerShell executable. */
  pwshPath?: string;
  /**
   * The runbook's `shell:`. A named shell other than the default is looked up by name; the
   * paths above are for bash and the default PowerShell only.
   */
  runbook?: RunbookShells;
  /**
   * Windows: add the PATH directories installed since VS Code started (read from the registry,
   * as a new terminal would) to each cell's environment. On unless `false`.
   */
  refreshPath?: boolean;
}

export interface ShellEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(file: string): boolean;
  /** Full path of an executable found on PATH, or undefined. */
  which(command: string): string | undefined;
}

export interface ResolvedShell {
  kind: ShellKind;
  /** Executable to spawn. */
  command: string;
  /** Short name for status lines. */
  label: string;
  /** Extension of the temporary script file. */
  extension: '.sh' | '.ps1' | '.cmd';
  /** Build the spawn arguments for a script file. */
  args(scriptPath: string): string[];
  /** Turn cell source into the script file's contents. */
  script(source: string): string;
  /** Pass args to cmd.exe without Node's quoting (Windows only). */
  windowsVerbatimArguments?: boolean;
}

export type ShellResolution = { ok: true; shell: ResolvedShell } | { ok: false; error: string };

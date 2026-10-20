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

export interface ShellSettings {
  /** Explicit bash executable (e.g. Git Bash on Windows). */
  bashPath?: string;
  /** Explicit PowerShell executable. */
  pwshPath?: string;
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

/**
 * Environment variables a runbook's front matter adds to the cells run on this machine (VS Code
 * and the command line, isolated and session mode):
 *
 * - `kube-context-mode: pin` (kubeContext.ts): KUBECONFIG = a temporary file that only says
 *   `current-context: NAME`, then your own kubeconfig list. Nothing is copied out of your
 *   kubeconfig, and your default context is never changed.
 * - `git-bash-path-conversion: off`: on Windows, Git Bash (MSYS) rewrites arguments that look like
 *   POSIX paths when it starts a Windows program (`kubectl exec pod -- ls /opt/x` gets
 *   `C:/Program Files/Git/opt/x`). These variables switch that off for the runbook's bash cells.
 *
 * The values are set for every cell, not only the first: in session mode the shell lives across
 * cells, and a cell's variables stay set after it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pinnedKubeconfig, pinnedKubeconfigList } from '../kubeContext';
import type { FrontMatter } from '../secrets';
import { shellKindForLanguage } from '../shellKind';

/** Git for Windows' and MSYS2's switches for argument conversion (`*` excludes every argument). */
export const NO_PATH_CONVERSION: Readonly<Record<string, string>> = { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };

/** `name`'s value in `env`, ignoring case on Windows (a copied env object is case-sensitive). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (f: string): boolean => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/**
 * Your kubeconfig list as kubectl reads it: `$KUBECONFIG`, else `.kube/config` in the home folder
 * client-go picks (on Windows the first of %HOME%, %HOMEDRIVE%%HOMEPATH%, %USERPROFILE% that has
 * one, else %USERPROFILE%).
 */
export function userKubeconfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = isFile): string {
  const list = envValue(env, 'KUBECONFIG', platform);
  if (list) return list;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform !== 'win32') return join(env.HOME || os.homedir(), '.kube', 'config');
  const drive = envValue(env, 'HOMEDRIVE', platform);
  const homePath = envValue(env, 'HOMEPATH', platform);
  const homes = [envValue(env, 'HOME', platform), drive && homePath ? drive + homePath : undefined, envValue(env, 'USERPROFILE', platform)].filter(
    (h): h is string => !!h,
  );
  const found = homes.map((h) => join(h, '.kube', 'config')).find(exists);
  return found ?? join(envValue(env, 'USERPROFILE', platform) || os.homedir(), '.kube', 'config');
}

/**
 * The pin files of one runbook run (the command line) or one open runbook (VS Code): one per
 * context name, in a folder only you can read, rewritten before every cell so each cell starts on
 * its context again (a `use-context` in an earlier cell changed the file). They hold no credential.
 * The folder is removed by dispose(); a file is kept until then because a session shell keeps the
 * KUBECONFIG it was given, and kubectl skips a missing file, which would fall back to your default.
 */
export class KubeconfigPins {
  private dir: string | undefined;
  private readonly files = new Map<string, string>();

  constructor(private readonly tmp: string = os.tmpdir()) {}

  /** The pin file for `context`, written now. */
  file(context: string): string {
    let file = this.files.get(context);
    if (file === undefined) this.files.set(context, (file = `pin-${this.files.size + 1}.kubeconfig`));
    const write = (): string => {
      this.dir ??= fs.mkdtempSync(path.join(this.tmp, 'md-runbook-kube-'));
      const full = path.join(this.dir, file!);
      // 0600 in a 0700 folder (mkdtemp's mode) on Unix; on Windows the temp folder is per user.
      fs.writeFileSync(full, pinnedKubeconfig(context), { mode: 0o600 });
      return full;
    };
    try {
      return write();
    } catch (e) {
      // The folder was removed under us (a temp cleaner): start a new one once.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.dir = undefined;
      return write();
    }
  }

  dispose(): void {
    if (this.dir === undefined) return;
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // In the temp folder, and it holds no credential.
    }
    this.dir = undefined;
  }
}

export interface RunbookEnvOptions {
  /** The cell's fence language. */
  language: string;
  frontMatter: FrontMatter | undefined;
  /** The context the cell is for: its kube-context=, else the front matter's (wantedKubeContext). */
  kubeContext: string | undefined;
  /** The environment the cell would get otherwise (VS Code's with the cell's own variables). */
  env: NodeJS.ProcessEnv;
  /** Where pin files go; undefined when pinning is turned off (the context is then only checked). */
  pins: KubeconfigPins | undefined;
  platform?: NodeJS.Platform;
}

/**
 * The variables to add to a cell, and whether its kube-context is pinned (the guard then checks
 * that the context exists rather than that it is current).
 */
export function runbookEnv(o: RunbookEnvOptions): { env: Record<string, string>; pinned: boolean } {
  const platform = o.platform ?? process.platform;
  const fm = o.frontMatter;
  const env: Record<string, string> = {};
  let pinned = false;
  if (fm?.kubeContextMode === 'pin' && o.pins) {
    const user = userKubeconfig(o.env, platform);
    if (o.kubeContext !== undefined) {
      env.KUBECONFIG = pinnedKubeconfigList(o.pins.file(o.kubeContext), user, platform);
      pinned = true;
    } else {
      // A cell for no context gets your own list: a session must not keep an earlier cell's pin.
      env.KUBECONFIG = user;
    }
  }
  if (fm?.gitBashPathConversion === 'off' && platform === 'win32' && shellKindForLanguage(o.language) === 'bash') Object.assign(env, NO_PATH_CONVERSION);
  return { env, pinned };
}

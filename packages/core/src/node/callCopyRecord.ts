/**
 * The command line's record of the call copies it wrote (core/callCopy.ts copyDigest): a JSON file
 * in its state folder, mode 600, outside any runbook folder. A run again continues a copy only when
 * its digest is the one kept here, so "done" outputs planted in a copy are never trusted.
 *
 * The folder: MD_RUNBOOK_STATE_DIR, else %LOCALAPPDATA%\md-runbook on Windows, else
 * $XDG_STATE_HOME/md-runbook (default ~/.local/state/md-runbook).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COPY_NOT_RECORDED, copyDigest, copyFrontMatterProblem } from '../callCopy';

/** At most this many copies are kept (the oldest go first). */
const MAX_COPIES = 500;

export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MD_RUNBOOK_STATE_DIR) return path.resolve(env.MD_RUNBOOK_STATE_DIR);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'md-runbook');
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'md-runbook');
}

const stateFile = (): string => path.join(stateDir(), 'call-copies.json');

/** The key of a copy: its full path (case folded where file names are). */
const keyOf = (copy: string): string => (process.platform === 'linux' ? path.resolve(copy) : path.resolve(copy).toLowerCase());

function read(file: string): Record<string, string> {
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8')) as { copies?: unknown };
    if (typeof x.copies !== 'object' || x.copies === null || Array.isArray(x.copies)) return {};
    return Object.fromEntries(Object.entries(x.copies as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** Keep the copy's digest after a run wrote it. Best effort: when it can't be written, the next run starts a fresh copy. */
export function recordCallCopy(copy: string, text: string, file = stateFile()): void {
  try {
    const copies = read(file);
    delete copies[keyOf(copy)];
    copies[keyOf(copy)] = copyDigest(text);
    const kept = Object.entries(copies).slice(-MAX_COPIES);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, copies: Object.fromEntries(kept) }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // not kept: the copy isn't continued
  }
}

/** Whether `text` is the copy as a run of the command line on this machine last wrote it. */
export function callCopyRecorded(copy: string, text: string, file = stateFile()): boolean {
  return read(file)[keyOf(copy)] === copyDigest(text);
}

/**
 * After resumeProblem: why the copy still can't be continued. Its front matter must be the one a
 * copy of `target` gets now (`added`: the values the call writes into it), and its text the one a
 * run here last wrote (`recorded`: the command line's state file, or VS Code's global state).
 */
export function resumeRecordProblem(
  copy: string,
  target: string,
  added: Record<string, string>,
  recorded: (copy: string, text: string) => boolean = (c, t) => callCopyRecorded(c, t),
): string | undefined {
  let copyText: string;
  let targetText: string;
  try {
    copyText = fs.readFileSync(copy, 'utf8');
    targetText = fs.readFileSync(target, 'utf8');
  } catch {
    return 'it can not be read';
  }
  return copyFrontMatterProblem(copyText, targetText, added) ?? (recorded(copy, copyText) ? undefined : COPY_NOT_RECORDED);
}

/**
 * The command line's record of the call copies it wrote (core/callCopy.ts copyDigest): a JSON file
 * in its state folder, mode 600, outside any runbook folder. A run again continues a copy only when
 * its digest is the one kept here, so "done" outputs planted in a copy are never trusted.
 *
 * The folder: MD_RUNBOOK_STATE_DIR, else %LOCALAPPDATA%\md-runbook on Windows, else
 * $XDG_STATE_HOME/md-runbook (default ~/.local/state/md-runbook). On Linux and macOS the folder and
 * the file must be yours, writable by you only, and no symbolic link; else the record is neither
 * read nor written, and no copy is continued. The file is replaced through a new temporary file of
 * a random name, never written through a link (security review, round 4).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COPY_NOT_RECORDED, copyDigest, copyFrontMatterProblem } from '../callCopy';
import { resumeProblem } from './call';

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

/**
 * Whether `p` is a folder (`dir`) or a file and no symbolic link; on Linux and macOS also owned by
 * this user and not writable by group or others. Windows: no owner check (its ACLs differ).
 */
export function ownedOnly(p: string, dir: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (dir ? !st.isDirectory() : !st.isFile()) return false;
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  return st.uid === process.getuid() && (st.mode & 0o022) === 0;
}

function read(file: string): Record<string, string> {
  if (!ownedOnly(path.dirname(file), true) || !ownedOnly(file, false)) return {};
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
    if (!ownedOnly(path.dirname(file), true)) return;
    if (fs.existsSync(file) || isLink(file)) {
      if (!ownedOnly(file, false)) return;
    }
    // A new file (O_EXCL: not one already there, nor a link), then renamed over the record.
    const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ version: 1, copies: Object.fromEntries(kept) }, null, 1) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    // not kept: the copy isn't continued
  }
}

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Whether `text` is the copy as a run of the command line on this machine last wrote it. */
export function callCopyRecorded(copy: string, text: string, file = stateFile()): boolean {
  return read(file)[keyOf(copy)] === copyDigest(text);
}

/**
 * After resumeProblem: why the copy still can't be continued. Its front matter must be the one a
 * copy of `target` gets now (`added`: the values the call writes into it), and its text the one a
 * run here last wrote (`recorded`: the command line's state file, or VS Code's global state).
 * `copyText`: the copy as already read (else it is read here).
 */
export function resumeRecordProblem(
  copy: string,
  target: string,
  added: Record<string, string>,
  recorded: (copy: string, text: string) => boolean = (c, t) => callCopyRecorded(c, t),
  copyText?: string,
): string | undefined {
  let targetText: string;
  try {
    copyText ??= fs.readFileSync(copy, 'utf8');
    targetText = fs.readFileSync(target, 'utf8');
  } catch {
    return 'it can not be read';
  }
  return copyFrontMatterProblem(copyText, targetText, added) ?? (recorded(copy, copyText) ? undefined : COPY_NOT_RECORDED);
}

/**
 * resumeProblem and resumeRecordProblem on one read of the copy: the text they checked, which the
 * run then uses (not the file read again: it could have changed in between), or why the copy
 * can't be continued.
 */
export function resumableCopy(
  copy: string,
  target: string,
  opts: { folder?: string; signed?: boolean },
  added: Record<string, string>,
  recorded: (copy: string, text: string) => boolean = (c, t) => callCopyRecorded(c, t),
): { text: string } | { problem: string } {
  let text: string;
  try {
    if (!fs.lstatSync(copy).isFile()) return { problem: 'it is not a file' };
    text = fs.readFileSync(copy, 'utf8');
  } catch {
    return { problem: 'it can not be read' };
  }
  const problem = resumeProblem(copy, target, { ...opts, text }) ?? resumeRecordProblem(copy, target, added, recorded, text);
  return problem === undefined ? { text } : { problem };
}

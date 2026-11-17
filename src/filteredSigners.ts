/**
 * What ssh-keygen gets as an allowed_signers file: a copy holding only the lines md-runbook reads
 * (allowedSigners.ts, strictly), each rebuilt in canonical form. So a line Trusted Signers… shows
 * as not used (an escape, a stray quote: OpenSSH could read another key there) never counts in a
 * check either, in your own file, a library's, or a file given to the command line.
 *
 * The copies live in a private folder of this process (mkdtemp: 0700 on POSIX; each file 0600),
 * removed when it exits. One copy per file and stamp (fileStamp: size and time), so a check of an
 * unchanged file reuses it, and an edit makes a new one. No vscode import: unit-tested.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkippedLine, canonicalLine, readSigners } from './allowedSigners';

let dir: string | undefined;
/** By file and stamp: the copy and the lines left out. */
const made = new Map<string, { file: string; refused: SkippedLine[] }>();

function privateDir(): string {
  if (dir && fs.existsSync(dir)) return dir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-signers-'));
  const gone = dir;
  process.once('exit', () => {
    try {
      fs.rmSync(gone, { recursive: true, force: true });
    } catch {
      // Left for the OS's temp cleanup.
    }
  });
  return dir;
}

/** The file as it is now: changes when it is written (or made, or removed). */
export function fileStamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/** The file's text with only the lines md-runbook reads, canonical; and the lines it left out. */
export function filteredSignersText(text: string): { text: string; refused: SkippedLine[] } {
  const { signers, skipped } = readSigners(text);
  return { text: signers.map((s) => canonicalLine(s) + '\n').join(''), refused: skipped };
}

/**
 * The copy of `file` to give ssh-keygen (made when the file changed), and the lines left out. A
 * file that can't be read is given as it is: ssh-keygen then says why.
 */
export function filteredSigners(file: string): { file: string; refused: SkippedLine[] } {
  const key = createHash('sha256').update(path.resolve(file)).update('\0').update(fileStamp(file)).digest('hex').slice(0, 32);
  const known = made.get(key);
  if (known && fs.existsSync(known.file)) return known;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, refused: [] };
  }
  const got = filteredSignersText(text);
  // Each version of a file its own copy, written whole: a check still reading the last one is not disturbed.
  const out = path.join(privateDir(), `${key}_allowed_signers`);
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, got.text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, out);
  const result = { file: out, refused: got.refused };
  made.set(key, result);
  return result;
}

/** The copy's path only (signature checks). */
export const filteredSignersFile = (file: string): string => filteredSigners(file).file;

/**
 * Runbook calls on disk (core/call.ts): where src= points, the files a parameterised src= can
 * match, and the run copy of the runbook called. Shared by the CLI and the extension.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFileName } from '../history';
import { withFrontMatterValues } from '../incident';
import { clearOutputBlocks } from '../writer';
import { recordValues } from '../call';
export { recordValues };
import { callEstimate } from '../estimate';
import { currentOs } from '../os';

/** The absolute path src= (placeholders filled) names, relative to the calling file's folder. */
export function callTarget(parentFile: string, src: string): string {
  return path.resolve(path.dirname(path.resolve(parentFile)), src);
}

/** `to` relative to the calling file's folder, with `/` separators (for output blocks and messages). */
export function relativeToCaller(parentFile: string, to: string): string {
  return path.relative(path.dirname(path.resolve(parentFile)), to).split(path.sep).join('/');
}

/** Whether two paths are the same file (case-insensitive on Windows and macOS). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      // not there (yet): compare as given
    }
    return process.platform === 'linux' ? r : r.toLowerCase();
  };
  return norm(a) === norm(b);
}

/** A reader for lint (core/lint.ts readRunbook): a static src= of the runbook `file`. */
export function runbookReader(file: string): (src: string) => string | undefined {
  return (src) => {
    try {
      const target = callTarget(file, src);
      return fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The files a glob of src= matches (`*` within a path segment), relative to the folder of `file`. */
export function matchRunbooks(file: string, glob: string): string[] {
  const parts = glob.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  const re = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, process.platform === 'linux' ? '' : 'i');
  let dirs = [path.dirname(path.resolve(file))];
  const out: string[] = [];
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    const next: string[] = [];
    for (const dir of dirs) {
      if (!seg.includes('*')) {
        const p = path.join(dir, seg);
        if (fs.existsSync(p)) next.push(p);
        continue;
      }
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      // A run copy is a record, not a runbook to call.
      for (const n of names) if (re(seg).test(n) && !/\.\d{8}-\d{6}(?:-\d+)?\.md$/i.test(n)) next.push(path.join(dir, n));
    }
    if (last) out.push(...next.filter((p) => fs.statSync(p).isFile()));
    else dirs = next.filter((p) => fs.statSync(p).isDirectory());
  });
  return out.map((p) => relativeToCaller(file, p)).sort();
}

/**
 * Write the run copy of `child` (no outputs; the caller's record settings in its front matter):
 * `<child>.<yyyyMMdd-HHmmss>.md` in `folder` (default: next to it), `-2`, `-3` … when taken.
 */
export function writeCallCopy(child: string, parentText: string, folder?: string, now = new Date()): string {
  const dir = folder ? path.resolve(path.dirname(child), folder) : path.dirname(child);
  fs.mkdirSync(dir, { recursive: true });
  const name = copyFileName(path.basename(child), now);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, name.replace(/\.md$/i, `-${n}.md`));
  const values = recordValues(parentText);
  const text = clearOutputBlocks(fs.readFileSync(child, 'utf8'));
  fs.writeFileSync(target, Object.keys(values).length ? withFrontMatterValues(text, values) : text, 'utf8');
  return target;
}

/**
 * How long a runbook call takes: its estimate=, else the estimates of what it runs (its selected
 * sections; calls in it too); undefined when that can't be known before the run (src= has
 * placeholders, the file is missing) or nothing in it has an estimate.
 */
export function callEstimateSeconds(file: string, info: string, source: string): number | undefined {
  const read = (src: string, from: string | undefined): { text: string; at: string } | undefined => {
    const target = callTarget(from ?? file, src);
    try {
      return { text: fs.readFileSync(target, 'utf8'), at: target };
    } catch {
      return undefined;
    }
  };
  return callEstimate(info, source, read, currentOs());
}

/** SHA-256 of a file's bytes, hex. */
export function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

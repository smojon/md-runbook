/**
 * The transcript: every run of a step appended to a text file as it happens, so what ran and what
 * it printed is on disk even if the runbook is never saved, and can be followed with `tail -f`.
 * VS Code writes one per runbook (`mdRunbook.output.transcript`), the command line with
 * `--transcript FILE`. The file writer is `node/transcript.ts`; this part only formats.
 *
 *     ===== 2026-10-28T22:14:05+01:00 · deploy.runbook.md · Step 12 · 5. Push · Push the platform
 *     $ git push origin main
 *     | Everything up-to-date
 *     ! fatal: unable to access …
 *     ===== exit=128 · 9.1s · check failed
 *
 * Output lines get a gutter: `| ` for stdout, `! ` for stderr, so headers (`=====`), attempts
 * (`-----`) and commands (`$ `) can't be mistaken for output. Each line is redacted as a whole
 * (and a private-key block at once) with the redaction of a saved runbook.
 */

import { stripAnsi } from './ansi';
import { LineBuffer } from './lineBuffer';
import { formatLocalIso, normalizeNewlines } from './outputBlock';

export const DEFAULT_TRANSCRIPT_EXTENSION = '.transcript.log';

export interface TranscriptStart {
  at: Date;
  /** The runbook's file name. */
  runbook: string;
  /** Its step number (Export Report's numbering). */
  step?: number;
  /** 1-based line of the opening fence, when known. */
  line?: number;
  /** The heading the step is under. */
  section?: string;
  /** The cell's `name=`, else its first line. */
  title?: string;
  /** The script as it runs (after placeholders); omitted for line runs, whose lines are echoed. */
  command?: string;
}

export interface TranscriptEnd {
  exit: string;
  durationMs: number;
  check?: 'ok' | 'failed';
  /** With retries: the attempt that ended the run, of `attempts`. */
  attempt?: number;
  attempts?: number;
  /** A line run of some lines only. */
  lines?: string;
}

/** "9.1s", "850ms", "2m5s": what a person reads in a log. */
export function formatTranscriptDuration(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  return t < 1000 ? `${t}ms` : t < 60_000 ? `${(t / 1000).toFixed(1)}s` : `${Math.floor(t / 60_000)}m${Math.round((t % 60_000) / 1000)}s`;
}

/** Header fields on one line: no line breaks inside a field. */
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export function transcriptHeader(s: TranscriptStart, redact: (text: string) => string): string {
  const where = s.step !== undefined ? `Step ${s.step}` : undefined;
  const file = s.line !== undefined ? `${s.runbook}:${s.line}` : s.runbook;
  const fields = [formatLocalIso(s.at), file, where, s.section, s.title].filter((f): f is string => f !== undefined && f.trim() !== '');
  let text = `===== ${redact(fields.map(oneLine).join(' · '))}\n`;
  if (s.command !== undefined && s.command.trim() !== '') {
    const lines = redact(stripAnsi(s.command).replace(/\r\n?/g, '\n').replace(/\n+$/, '')).split('\n');
    text += lines.map((l) => `$ ${l}`).join('\n') + '\n';
  }
  return text;
}

export function transcriptFooter(e: TranscriptEnd): string {
  const parts = [
    `exit=${e.exit}`,
    formatTranscriptDuration(e.durationMs),
    e.check && `check ${e.check === 'ok' ? 'passed' : 'failed'}`,
    e.attempt !== undefined && e.attempts !== undefined && e.attempts > 1 && `attempt ${e.attempt}/${e.attempts}`,
    e.lines && `lines ${e.lines}`,
  ].filter(Boolean);
  return `===== ${parts.join(' · ')}\n\n`;
}

/** A line of its own, outside a step (a checklist item ticked, a step not run). */
export function transcriptNote(at: Date, runbook: string, text: string, redact: (text: string) => string): string {
  return `===== ${redact(oneLine(`${formatLocalIso(at)} · ${runbook} · ${text}`))}\n\n`;
}

type Stream = 'stdout' | 'stderr';
const GUTTER: Record<Stream, string> = { stdout: '| ', stderr: '! ' };

/**
 * One run of a step in the transcript: `start`, output as it arrives, `attempt` before a retry,
 * `end`. With `hold`, output is kept until `end` and redacted then: a step that captures a secret
 * only knows the value when it has finished, and a file can't be redrawn.
 */
export class TranscriptEntry {
  private readonly buffers: Record<Stream, LineBuffer>;
  private readonly carry: Record<Stream, string> = { stdout: '', stderr: '' };
  private readonly held: { stream: Stream; text: string }[] = [];
  private ended = false;

  constructor(
    private readonly write: (text: string) => void,
    /** Called for every line, so secrets learnt during the run are redacted from then on. */
    private readonly redact: (text: string) => string,
    private readonly hold = false,
  ) {
    const buffer = (stream: Stream): LineBuffer => new LineBuffer((t) => this.lines(stream, t), (t) => this.redact(stripAnsi(t)));
    this.buffers = { stdout: buffer('stdout'), stderr: buffer('stderr') };
  }

  start(s: TranscriptStart): void {
    this.write(transcriptHeader(s, this.redact));
  }

  out(stream: Stream, text: string): void {
    if (this.ended || text === '') return;
    if (this.hold) this.held.push({ stream, text });
    else this.buffers[stream].write(text);
  }

  /** A retry starts: what came before stays, the next attempt is marked. */
  attempt(n: number, of: number, at: Date): void {
    if (this.ended) return;
    this.release();
    this.write(`----- attempt ${n}/${of} · ${formatLocalIso(at)}\n`);
  }

  end(e: TranscriptEnd): void {
    if (this.ended) return;
    this.release();
    this.ended = true;
    this.write(transcriptFooter(e));
  }

  /** Write what is buffered or held, redacted with what is known now. */
  private release(): void {
    for (const h of this.held.splice(0)) this.buffers[h.stream].write(h.text);
    for (const stream of ['stdout', 'stderr'] as const) {
      this.buffers[stream].flush();
      if (this.carry[stream] !== '') this.lines(stream, '\n');
    }
  }

  private lines(stream: Stream, text: string): void {
    const parts = (this.carry[stream] + text).split('\n');
    this.carry[stream] = parts.pop()!;
    if (parts.length > 0) this.write(parts.map((l) => GUTTER[stream] + normalizeNewlines(l)).join('\n') + '\n');
  }
}

/**
 * Why `ext` can't be a transcript's extension, or undefined. It is appended to the runbook's name
 * without `.md`: a dot first, no folder, and not `.md`, which would open as a runbook itself.
 */
export function transcriptExtensionProblem(ext: string): string | undefined {
  if (!/^\.[^\s/\\]+$/.test(ext)) return 'it must start with a dot and hold no spaces or slashes';
  if (/\.(md|markdown)$/i.test(ext)) return 'a .md transcript would open as a runbook';
  return undefined;
}

/** `deploy.runbook.md` -> `deploy.runbook.transcript.log`. */
export function transcriptFileName(runbook: string, ext = DEFAULT_TRANSCRIPT_EXTENSION): string {
  return runbook.replace(/\.(md|markdown)$/i, '') + ext;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** The text of the last ATX heading in a Markdown cell, outside fenced blocks, or undefined. */
export function lastHeading(markdown: string): string | undefined {
  let fence: string | undefined;
  let last: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === undefined) fence = f[1]![0]!.repeat(f[1]!.length);
      else if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const m = ATX_RE.exec(line);
    if (m) last = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
  }
  return last;
}

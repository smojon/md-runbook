/**
 * Run one cell of a runbook on a host and put its output block into the runbook text, the way
 * the extension does: the same attributes (`exit`, `ran`, `ended`, `duration`, `check`), the
 * same cleaning, redaction and truncation (the core writer), so the file stays the one format.
 */
import {
  DEFAULT_PATTERNS,
  DEFAULT_WRITE_OPTIONS,
  createRedactor,
  exitLabel,
  formatDurationAttr,
  formatLocalIso,
  outputSummary,
  parse,
  setCellOutput,
} from '@md-runbook/core';
import { evaluateChecks } from '@md-runbook/core/checks';
import type { SessionRunResult } from '@md-runbook/ssh';
import type { Host } from '../hosts/store';
import { t } from '../i18n';
import { runnability } from './cells';
import { Connection, connectionFor } from './connections';

/** A cell without `timeout=` is stopped after this long. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type RunOutcome =
  /** The cell ran (or failed): `text` is the runbook with the new output block. */
  | { kind: 'done'; text: string; result: SessionRunResult; attrs: Record<string, string>; summary: string }
  /** The server's key is not trusted yet (or changed): nothing was sent; ask, pin, run again. */
  | { kind: 'trust'; hostKey: string; changed: boolean }
  /** Nothing ran: the cell can't run here, or the connection failed. */
  | { kind: 'error'; message: string };

export interface RunCellParams {
  host: Host;
  /** The whole runbook. */
  text: string;
  cellIndex: number;
  signal?: AbortSignal;
  /** Output as it arrives (stdout and stderr in order of arrival). */
  onOutput?(text: string): void;
  /** Tests: a connection instead of the host's real one. */
  connection?: Connection;
}

const redactor = createRedactor(DEFAULT_PATTERNS);

export async function runCell(p: RunCellParams): Promise<RunOutcome> {
  const cell = parse(p.text).cells[p.cellIndex];
  if (!cell) return { kind: 'error', message: t.cellGone };
  const can = runnability(cell);
  if (!can.ok) return { kind: 'error', message: t.notRunnable[can.why](can.detail) };
  const opts = can.options;

  let conn: Connection;
  try {
    conn = p.connection ?? (await connectionFor(p.host));
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  conn.unknownHostKey = undefined;

  const started = new Date();
  let transcript = '';
  let stdout = '';
  const write = (text: string): void => {
    transcript += text;
    p.onOutput?.(text);
  };
  let result: SessionRunResult;
  try {
    result = await conn.session.run(cell.value, {
      env: opts.env,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutSeconds * 1000,
      signal: p.signal,
      onStdout: (text) => {
        stdout += text;
        write(text);
      },
      onStderr: write,
    });
  } catch (e) {
    if (conn.unknownHostKey) return { kind: 'trust', hostKey: conn.unknownHostKey, changed: conn.changed ?? false };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  if (result.error !== undefined) write(result.error + '\n');
  if (result.timedOut) write(t.timedOutNote(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) + '\n');
  const ended = new Date();
  const attrs: Record<string, string> = {
    exit: exitLabel(result),
    ran: formatLocalIso(started),
    ended: formatLocalIso(ended),
    duration: formatDurationAttr(ended.getTime() - started.getTime()),
  };
  if (opts.checks && result.exitCode !== null && !result.timedOut && !result.cancelled) {
    const outcome = evaluateChecks(opts.checks, result.exitCode, transcript, stdout);
    attrs.check = outcome.ok ? 'ok' : 'failed';
    for (const f of outcome.failures) write(t.checkFailedNote(f) + '\n');
  }
  const text =
    setCellOutput(p.text, p.cellIndex, { kind: 'new', text: transcript, attrs }, { ...DEFAULT_WRITE_OPTIONS, redact: redactor.redact }) ??
    p.text;
  return { kind: 'done', text, result, attrs, summary: outputSummary(attrs, ended) };
}

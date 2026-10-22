/**
 * What is sent to the remote shell. Pure functions, so they can be tested without a server.
 *
 * A cell travels as a quoted here-doc with a random terminator (the cell's text can't end it), is
 * written to a temp file and sourced in the shell, so `cd` and variables carry over to the next
 * cell, as in a local session (core/node/session.ts). Then the end-of-cell marker
 * `<RS>__MDRB_<id>__ <exit>` is printed on stderr and on stdout: both, because the two streams
 * reach us separately and stderr could otherwise still be on its way when stdout ends.
 */

import { Buffer } from 'buffer';

/** Started by the `exec` request: bash as a login shell (for the user's PATH), else sh. */
export const SHELL_COMMAND = 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l';

export const markerFor = (id: string): string => `__MDRB_${id}__`;

/** POSIX single quotes. */
export const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const printMarker = (marker: string, value: string): string =>
  `printf '\\036%s %s\\n' ${marker} ${value} >&2; printf '\\036%s %s\\n' ${marker} ${value}\n`;

/**
 * First line sent: reports the shell's process id (for cancelling) as its marker value. A plain
 * shell runs it as is (`:` does nothing); md-runbook-gate recognizes it and answers with its
 * banner first (`gateBanner`).
 */
export function helloCommand(id: string): string {
  return `: mdrb-gate-hello ${id}; ` + printMarker(markerFor(id), '"$$"');
}

/** What md-runbook-gate said about itself in its answer to the hello. */
export interface GateInfo {
  protocol: number;
  /** Whether this server (for this key) runs cells that are not signed. */
  unsigned: 'allow' | 'refuse';
}

/** The gate's banner in the output before the hello's marker; undefined for a plain shell. */
export function gateBanner(output: string): GateInfo | undefined {
  const m = /\x1e__MDRB_GATE__ (\d+) unsigned=(allow|refuse)\n/.exec(output);
  return m ? { protocol: Number(m[1]), unsigned: m[2] as 'allow' | 'refuse' } : undefined;
}

/** The gate's answer to a load: the principal whose signature it accepted, and the manifest's sha256. */
export function signedReply(output: string): { principal: string; hash: string } | undefined {
  const m = /\x1e__MDRB_SIGNED__ (\S+) ([0-9a-f]{64})\n/.exec(output);
  return m ? { principal: m[1]!, hash: m[2]! } : undefined;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Gate requests (one line each; see apps/gate/md-runbook-gate). `signature` is the SSHSIG blob, base64. */
export const gateLoadCommand = (id: string, manifest: string, signature: string): string => `load ${id} ${b64(manifest)} ${signature}\n`;
export const gateParamCommand = (id: string, name: string, value: string): string => `param ${id} ${name} ${b64(value)}\n`;
export const gateRunCommand = (id: string, cell: number, step?: number): string =>
  step === undefined ? `run ${id} ${Math.trunc(cell)}\n` : `step ${id} ${Math.trunc(cell)} ${Math.trunc(step)}\n`;
/** An unsigned cell, for a gate that allows them: the text a plain shell would get. */
export const gateRawCommand = (id: string, text: string): string => `raw ${id} ${b64(text)}\n`;

export interface CellCommandOptions {
  /** Exported before the cell runs (and kept for later cells, as in a local session). */
  env?: Record<string, string>;
  /** Runs the cell in this folder, then goes back to the folder the session was in. */
  cwd?: string;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The text sent to the shell for one cell. Values in `env` go through the channel only, never
 * to the remote disk (the temp file holds the cell's text, which has placeholders, not secrets).
 */
export function cellCommand(source: string, id: string, opts: CellCommandOptions = {}): string {
  const marker = markerFor(id);
  const eof = `__MDRB_EOF_${id}`;
  const body = source.endsWith('\n') ? source : source + '\n';
  const exportLines = Object.entries(opts.env ?? {})
    .filter(([k]) => VAR_NAME.test(k))
    .map(([k, v]) => `export ${k}=${sq(v)}\n`)
    .join('');
  // stdin is the command stream, so the cell reads from /dev/null like an isolated run.
  const run = '. "$__mdrb_f" </dev/null; __mdrb_rc=$?';
  const runIn =
    opts.cwd === undefined
      ? `${run}; `
      : `__mdrb_cd=$PWD; if cd -- ${sq(opts.cwd)}; then ${run}; cd -- "$__mdrb_cd" 2>/dev/null; else __mdrb_rc=1; fi; `;
  return (
    `__mdrb_f=$(mktemp) && cat > "$__mdrb_f" <<'${eof}'\n${body}${eof}\n` +
    exportLines +
    runIn +
    'rm -f "$__mdrb_f"; ' +
    printMarker(marker, '"$__mdrb_rc"')
  );
}

/**
 * Command for a second channel that stops the cell running in the shell `pid` without ending
 * the shell: it signals the shell's children (the cell's commands), so the shell prints the
 * marker and keeps its folder and variables.
 */
export function stopCommand(pid: number, signal: 'TERM' | 'KILL'): string {
  return `pkill -${signal} -P ${Math.trunc(pid)} 2>/dev/null; true`;
}

/** A random id for markers and here-doc terminators (Web Crypto: Node 20+, browsers, React Native polyfill). */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

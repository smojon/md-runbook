/**
 * What is sent to the remote shell. Pure functions, so they can be tested without a server.
 *
 * A cell travels as a quoted here-doc with a random terminator (the cell's text can't end it), is
 * written to a temp file and sourced in the shell, so `cd` and variables carry over to the next
 * cell, as in a local session (core/node/session.ts). Then the end-of-cell marker
 * `<RS>__MDRB_<id>__ <exit>` is printed on stderr and on stdout: both, because the two streams
 * reach us separately and stderr could otherwise still be on its way when stdout ends.
 */

/** Started by the `exec` request: bash as a login shell (for the user's PATH), else sh. */
export const SHELL_COMMAND = 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l';

export const markerFor = (id: string): string => `__MDRB_${id}__`;

/** POSIX single quotes. */
export const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const printMarker = (marker: string, value: string): string =>
  `printf '\\036%s %s\\n' ${marker} ${value} >&2; printf '\\036%s %s\\n' ${marker} ${value}\n`;

/** First line sent: reports the shell's process id (for cancelling) as its marker value. */
export function helloCommand(id: string): string {
  return printMarker(markerFor(id), '"$$"');
}

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
  const exports = Object.entries(opts.env ?? {})
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
    exports +
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

/**
 * Per-cell options in the fence info string, after the language word:
 *
 *   ```bash timeout=30 cwd=../infra continue-on-error env.REGION=eu name="Rotate token"
 *
 * Tokens are `key=value`, `key="quoted value"` (or single quotes) and bare flags. Unknown tokens
 * and pandoc `{…}` attributes are ignored. Backslashes are literal, so Windows paths work as is.
 */

export interface CellOptions {
  /** Seconds; 0 = no timeout. */
  timeoutSeconds?: number;
  /** As written; relative paths are resolved against the .md file's folder. */
  cwd?: string;
  continueOnError?: boolean;
  skip?: boolean;
  /** true = always confirm (`confirm`), false = never (`no-confirm`). */
  confirm?: boolean;
  /** Run in a VS Code terminal (only honoured when `mdRunbook.terminal.mode` allows it). */
  terminal?: boolean;
  env: Record<string, string>;
  name?: string;
  /** Recognized keys with invalid values. */
  errors: string[];
}

export interface InfoToken {
  key: string;
  /** undefined for a bare flag. */
  value?: string;
  /** Offsets of the whole token (key, `=` and value with its quotes) in the tokenized text. */
  start: number;
  end: number;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** Split the part of an info string after the language word into tokens. */
export function tokenizeInfo(rest: string): InfoToken[] {
  const tokens: InfoToken[] = [];
  const n = rest.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(rest[i])) i++;
    if (i >= n) break;
    if (rest[i] === '{') {
      // Pandoc attributes: skip to the closing brace (or the end).
      const close = rest.indexOf('}', i);
      i = close < 0 ? n : close + 1;
      continue;
    }
    const start = i;
    while (i < n && !isSpace(rest[i]) && rest[i] !== '=') i++;
    const key = rest.slice(start, i);
    if (rest[i] !== '=') {
      tokens.push({ key, start, end: i });
      continue;
    }
    i++;
    const q = rest[i];
    let value: string;
    if (q === '"' || q === "'") {
      const close = rest.indexOf(q, i + 1);
      value = rest.slice(i + 1, close < 0 ? n : close);
      i = close < 0 ? n : close + 1;
    } else {
      const vs = i;
      while (i < n && !isSpace(rest[i])) i++;
      value = rest.slice(vs, i);
    }
    if (key !== '') tokens.push({ key, value, start, end: i });
  }
  return tokens;
}

const LANG_RE = /^\s*[^\s{]*/;

/**
 * Rewrite whole tokens of a fence info string (after the language word), leaving everything else
 * (quoted values included) byte for byte. `replace` returns the new text for a token, `''` to drop
 * it (with the whitespace before it), or undefined to keep it.
 */
export function rewriteInfoTokens(info: string, replace: (t: InfoToken) => string | undefined): string {
  const off = (LANG_RE.exec(info)?.[0] ?? '').length;
  let out = '';
  let pos = 0;
  for (const t of tokenizeInfo(info.slice(off))) {
    const r = replace(t);
    if (r === undefined) continue;
    const before = info.slice(pos, off + t.start);
    out += r === '' ? before.replace(/[ \t]+$/, '') : before + r;
    pos = off + t.end;
  }
  return out + info.slice(pos);
}

export function parseCellOptions(info: string): CellOptions {
  const opts: CellOptions = { env: {}, errors: [] };
  for (const { key, value } of tokenizeInfo(info.replace(LANG_RE, ''))) {
    const k = key.toLowerCase();
    if (value === undefined) {
      if (k === 'continue-on-error') opts.continueOnError = true;
      else if (k === 'skip') opts.skip = true;
      else if (k === 'confirm') opts.confirm = true;
      else if (k === 'no-confirm') opts.confirm = false;
      else if (k === 'terminal') opts.terminal = true;
    } else if (k === 'timeout') {
      const s = Number(value.replace(/s$/i, ''));
      if (value.trim() === '' || !Number.isFinite(s) || s < 0) opts.errors.push(`timeout=${value}: expected seconds (0 = none)`);
      else opts.timeoutSeconds = s;
    } else if (k === 'cwd') {
      if (value === '') opts.errors.push('cwd: empty path');
      else opts.cwd = value;
    } else if (k === 'name') {
      opts.name = value;
    } else if (k.startsWith('env.') && key.length > 4) {
      opts.env[key.slice(4)] = value; // keep the variable's case
    }
  }
  return opts;
}

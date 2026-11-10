import { CellChecks, MAX_EVERY_MS, MAX_RETRY, checkRefText, parseCapture, parseInterval, parseMatcher } from './checks';
import { VarRef, findRefs } from './secrets';
import { isKubeContextValue, kubeContextRefText, wantedKubeContext } from './kubeContext';
import { OsName, parseOsList } from './os';

/**
 * Per-cell options in the fence info string, after the language word:
 *
 *   ```bash timeout=30 cwd=../infra continue-on-error env.REGION=eu name="Rotate token"
 *   ```bash expect="Running" retry=10 every=15s capture=POD:/^(web-\S+)/m
 *
 * Tokens are `key=value`, `key="quoted value"` (or single quotes) and bare flags. Unknown tokens
 * and pandoc `{…}` attributes are ignored. Backslashes are literal, so Windows paths work as is.
 */

export interface CellOptions {
  /** Seconds; 0 = no timeout. */
  timeoutSeconds?: number;
  /** estimate=2m30s: how long the block takes, in seconds (shown only; it never changes a run). */
  estimateSeconds?: number;
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
  /** expect=, expect-not=, expect-exit=, capture=, capture-secret= (undefined when none is set). */
  checks?: CellChecks;
  /** os=windows,linux: the block is only for these systems (an alternative of the blocks around it). */
  os?: OsName[];
  /**
   * host=NAME: the block runs on that host over SSH (a host of the md-runbook app, by name).
   * The extension and the CLI run cells locally, so they never run such a block.
   */
  host?: string;
  /** kube-context=NAME: the block runs only while `kubectl config current-context` is NAME (kubeContext.ts). */
  kubeContext?: string;
  /**
   * lines=any: in a signed runbook, single lines and ranges of this block may run on a server
   * with md-runbook-gate (otherwise only the whole block, or its commands in order).
   */
  lines?: 'any';
  /** retry=N: up to N attempts in all, `every` apart (default 5 s). */
  retry?: { attempts: number; everyMs: number };
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

/**
 * `info` with the first option named `from` (any case) renamed to `to`, its value kept as written
 * (a typo's fix); undefined when there is no such option.
 */
export function renameInfoOption(info: string, from: string, to: string): string | undefined {
  const off = (LANG_RE.exec(info)?.[0] ?? '').length;
  let found = false;
  const out = rewriteInfoTokens(info, (t) => {
    if (found || t.key.toLowerCase() !== from.toLowerCase()) return undefined;
    found = true;
    return to + info.slice(off + t.start + t.key.length, off + t.end);
  });
  return found ? out : undefined;
}

/**
 * The `${…}` references a block uses: in its code, then in its checks (expect=, expect-not=),
 * which are filled in before they are judged, then its kube-context's (`kube-context=${param:NAME}`,
 * or the front matter's for a block without one). Only the code's are rewritten into the script.
 * Throws as findRefs does (a name used as two kinds).
 */
export function cellRefs(source: string, info: string, frontMatter?: { kubeContext?: string }): VarRef[] {
  const opts = parseCellOptions(info);
  const more = [checkRefText(opts.checks), kubeContextRefText(wantedKubeContext(opts, frontMatter))].filter((t) => t !== '');
  return findRefs([source, ...more].join('\n'));
}

export function parseCellOptions(info: string): CellOptions {
  const opts: CellOptions = { env: {}, errors: [] };
  const checks = (): CellChecks => (opts.checks ??= { captures: [] });
  let every: number | undefined;
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
    } else if (k === 'estimate') {
      const ms = parseInterval(value);
      if (ms === undefined) opts.errors.push(`estimate=${value}: expected a duration such as 2m30s, 45s or 90 (seconds)`);
      else opts.estimateSeconds = ms / 1000;
    } else if (k === 'cwd') {
      if (value === '') opts.errors.push('cwd: empty path');
      else opts.cwd = value;
    } else if (k === 'name') {
      opts.name = value;
    } else if (k === 'expect' || k === 'expect-not') {
      try {
        checks()[k === 'expect' ? 'expect' : 'expectNot'] = parseMatcher(value);
      } catch (e) {
        opts.errors.push(`${k}=${value}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (k === 'expect-exit') {
      if (!/^-?\d+$/.test(value.trim())) opts.errors.push(`expect-exit=${value}: expected an exit code`);
      else checks().expectExit = Number(value);
    } else if (k === 'capture' || k === 'capture-secret') {
      try {
        checks().captures.push(parseCapture(value, k === 'capture-secret'));
      } catch (e) {
        opts.errors.push(`${k}=${value}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (k === 'os') {
      const os = parseOsList(value);
      if (typeof os === 'string') opts.errors.push(`os=${value}: ${os}`);
      else opts.os = os;
    } else if (k === 'host') {
      if (value.trim() === '') opts.errors.push('host: empty name');
      else opts.host = value.trim();
    } else if (k === 'kube-context') {
      if (!isKubeContextValue(value.trim())) opts.errors.push(`kube-context=${value}: expected a Kubernetes context name or \${param:NAME}`);
      else opts.kubeContext = value.trim();
    } else if (k === 'lines') {
      if (value.toLowerCase() !== 'any') opts.errors.push(`lines=${value}: expected lines=any`);
      else opts.lines = 'any';
    } else if (k === 'retry') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_RETRY) opts.errors.push(`retry=${value}: expected the number of attempts (1 to ${MAX_RETRY})`);
      else opts.retry = { attempts: n, everyMs: 5000 };
    } else if (k === 'every') {
      every = parseInterval(value);
      if (every === undefined) opts.errors.push(`every=${value}: expected a duration such as 15s, 500ms or 2m`);
      else if (every > MAX_EVERY_MS) opts.errors.push(`every=${value}: at most 1h`);
    } else if (k.startsWith('env.') && key.length > 4) {
      opts.env[key.slice(4)] = value; // keep the variable's case
    }
  }
  if (opts.retry && every !== undefined) opts.retry.everyMs = every;
  return opts;
}

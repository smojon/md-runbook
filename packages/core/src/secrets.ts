/**
 * Variable references in cell source (`${secret:NAME}`, `${input:NAME}`, `${param:NAME}`,
 * `${out:NAME}` for a value captured from an earlier cell's output), runbook
 * parameters from front matter, and `.env` files. Values never go into the script text: each
 * reference is rewritten to the shell's own environment variable syntax and the value is passed
 * in the environment.
 */

import { RunbookShells, ShellKind, parseShells } from './shellKind';

export type RefKind = 'secret' | 'input' | 'param' | 'out';

export interface VarRef {
  kind: RefKind;
  name: string;
  /** Value must be masked when asked for and redacted from output (for `out`: known once resolved). */
  secret: boolean;
}

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REF_RE = /\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

/** Inputs named like credentials are treated as secret without the `:secret` suffix. */
export function looksSecret(name: string): boolean {
  return /_(PASSWORD|TOKEN|SECRET)$/i.test(name);
}

/** Unique references in order of first appearance. `:secret` is only valid on inputs. */
export function findRefs(source: string): VarRef[] {
  const out = new Map<string, VarRef>();
  for (const m of source.matchAll(REF_RE)) {
    const kind = m[1] as RefKind;
    const name = m[2]!;
    if (m[3] && kind !== 'input') continue;
    const secret = kind === 'secret' || (kind === 'input' && (!!m[3] || looksSecret(name)));
    const prev = out.get(name);
    if (prev && prev.kind !== kind) throw new Error(`${name} is referenced as both ${prev.kind} and ${kind}`);
    if (prev) prev.secret ||= secret;
    else out.set(name, { kind, name, secret });
  }
  return [...out.values()];
}

/** How a shell reads environment variable `name`. */
export function envRef(name: string, shell: ShellKind): string {
  switch (shell) {
    case 'bash':
      return '${' + name + '}';
    case 'pwsh':
      return '${env:' + name + '}';
    case 'cmd':
      // Delayed expansion: cmd expands %VAR% before it parses the line, so a value like `p&calc`
      // would run calc; !VAR! is expanded after parsing and never re-parsed.
      return '!' + name + '!';
  }
}

/** First line of a cmd script whose references were rewritten to `!NAME!`. */
export const CMD_DELAYED_EXPANSION = '@setlocal EnableDelayedExpansion';

/**
 * Replace every reference with the shell's environment variable syntax. A cmd script that had
 * references gets `@setlocal EnableDelayedExpansion` as its first line (scripts without
 * references are left alone, so a literal `!` in them keeps working).
 */
export function rewriteRefs(source: string, shell: ShellKind): string {
  let changed = false;
  const out = source.replace(REF_RE, (whole, kind: string, name: string, mod: string | undefined) => {
    if (mod && kind !== 'input') return whole;
    changed = true;
    return envRef(name, shell);
  });
  if (shell !== 'cmd' || !changed) return out;
  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  return CMD_DELAYED_EXPANSION + eol + out;
}

export interface RunbookParam {
  name: string;
  default?: string;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.startsWith('"') ? v.slice(1, -1).replace(/\\(["\\])/g, '$1') : v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

export interface FrontMatter {
  params: RunbookParam[];
  mode?: 'session' | 'isolated';
  /** `timeout:` in seconds: the default for this runbook's cells (0 = none). */
  timeoutSeconds?: number;
  /** `cwd:` as written: the runbook's working folder, relative to the .md file's folder. */
  cwd?: string;
  /** `shell:`: the installed shells its cells run in, by name (lint reports names it ignored). */
  shell?: RunbookShells;
}

/**
 * `params:`, `mode:`, `timeout:`, `cwd:` and `shell:` from YAML-style front matter (`---` ... `---`
 * at the very top). Only this subset is understood; other keys are ignored. Param items are
 * `- name` or `- name: default`; `mode` is `session` or `isolated`; `timeout` is seconds (`120`
 * or `120s`); `shell` names shells (`zsh, windows-powershell`, see parseShells).
 * Returns undefined when the text has no front matter.
 */
export function parseFrontMatter(text: string): FrontMatter | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const params: RunbookParam[] = [];
  let mode: 'session' | 'isolated' | undefined;
  let timeoutSeconds: number | undefined;
  let cwd: string | undefined;
  let shell: RunbookShells | undefined;
  let inParams = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(---|\.\.\.)\s*$/.test(line)) {
      return {
        params,
        ...(mode ? { mode } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(shell ? { shell } : {}),
      };
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line) && !line.startsWith('-')) {
      // A top-level key.
      inParams = /^params\s*:\s*$/.test(line);
      const m = /^mode\s*:\s*["']?(session|isolated)["']?\s*(#.*)?$/i.exec(line);
      if (m) mode = m[1]!.toLowerCase() as 'session' | 'isolated';
      const t = /^timeout\s*:\s*["']?(\d+(?:\.\d+)?)s?["']?\s*(#.*)?$/i.exec(line);
      if (t) timeoutSeconds = Number(t[1]);
      const c = /^cwd\s*:\s*(.*?)\s*$/i.exec(line);
      if (c && c[1] !== '') cwd = unquote(c[1]!.replace(/\s+#.*$/, ''));
      const sh = /^shell\s*:\s*(.*?)\s*(#.*)?$/i.exec(line);
      if (sh) {
        const { shells } = parseShells(sh[1]!);
        if (shells.unix || shells.powershell) shell = shells;
      }
      continue;
    }
    if (!inParams) continue;
    const item = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.*?))?\s*$/.exec(line);
    if (!item) continue;
    const name = item[1]!;
    if (params.some((p) => p.name === name)) continue;
    params.push(item[2] !== undefined && item[2] !== '' ? { name, default: unquote(item[2]) } : { name });
  }
  return undefined; // never closed: not front matter
}

const DQ_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' };

/** Parse `KEY=VALUE` lines: `#` comments, an optional `export ` prefix, single/double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!;
    if (v.startsWith('"')) {
      let s = '';
      let i = 1;
      for (; i < v.length && v[i] !== '"'; i++) {
        if (v[i] === '\\' && i + 1 < v.length) s += DQ_ESCAPES[v[++i]!] ?? '\\' + v[i];
        else s += v[i];
      }
      v = s;
    } else if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      v = end < 0 ? v.slice(1) : v.slice(1, end);
    } else {
      v = v.replace(/(^|\s+)#.*$/, '').trim();
    }
    out[m[1]!] = v;
  }
  return out;
}

/** Values too common to redact as exact matches (flags, ports): they would mangle unrelated output. */
export function isRedactableValue(v: string): boolean {
  return !/^(true|false|yes|no|on|off|null|none|\d{1,5})$/i.test(v);
}

/**
 * `.env` keys whose values are credentials: *_TOKEN, *_SECRET, *PASSWORD*, *PASSWD*, *KEY*
 * (API_KEY, ACCESS_KEY_ID, …), *CREDENTIAL*, *AUTH*, *COOKIE*, *SESSION*, *PRIVATE*, *DSN*,
 * connection strings.
 */
export function looksSecretKey(name: string): boolean {
  return (
    looksSecret(name) ||
    /(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|PRIVATE|COOKIE|SESSION|(^|_)KEY(_|$)|APIKEY|ACCESSKEY|(^|_)AUTH(_|$)|(^|_)DSN$|CONN(ECTION)?_?STR(ING)?)/i.test(name)
  );
}

/** Shannon entropy in bits per character. */
function entropy(v: string): number {
  const counts = new Map<string, number>();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / v.length) * Math.log2(n / v.length);
  return h;
}

/** A value that looks like a key or token whatever its name: long, mixed, random-looking, or a URL with a password. */
export function looksLikeSecretValue(v: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i.test(v)) return true; // scheme://user:pass@host
  if (v.length < 16 || /\s/.test(v) || /^[a-z]+:\/\/|^[./~]|^[A-Za-z]:\\/.test(v)) return false; // URLs and paths aren't keys
  return /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) >= 3.5;
}

/** The values of a parsed `.env` file to redact by exact match. */
export function dotenvSecrets(vars: Record<string, string>): string[] {
  return Object.entries(vars)
    .filter(([k, v]) => isRedactableValue(v) && (looksSecretKey(k) || looksLikeSecretValue(v)))
    .map(([, v]) => v);
}

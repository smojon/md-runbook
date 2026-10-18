/**
 * Variable references in cell source (`${secret:NAME}`, `${input:NAME}`, `${param:NAME}`), runbook
 * parameters from front matter, and `.env` files. Values never go into the script text: each
 * reference is rewritten to the shell's own environment variable syntax and the value is passed
 * in the environment.
 */

import type { ShellKind } from './shell';

export type RefKind = 'secret' | 'input' | 'param';

export interface VarRef {
  kind: RefKind;
  name: string;
  /** Value must be masked when asked for and redacted from output. */
  secret: boolean;
}

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REF_RE = /\$\{(secret|input|param):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

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
      return '%' + name + '%';
  }
}

/** Replace every reference with the shell's environment variable syntax. */
export function rewriteRefs(source: string, shell: ShellKind): string {
  return source.replace(REF_RE, (whole, kind: string, name: string, mod: string | undefined) =>
    mod && kind !== 'input' ? whole : envRef(name, shell),
  );
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

/**
 * `params:` and `mode:` from YAML-style front matter (`---` ... `---` at the very top). Only this
 * subset is understood; other keys are ignored. Param items are `- name` or `- name: default`;
 * `mode` is `session` or `isolated`. Returns undefined when the text has no front matter.
 */
export function parseFrontMatter(text: string): { params: RunbookParam[]; mode?: 'session' | 'isolated' } | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const params: RunbookParam[] = [];
  let mode: 'session' | 'isolated' | undefined;
  let inParams = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(---|\.\.\.)\s*$/.test(line)) return mode ? { params, mode } : { params };
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line) && !line.startsWith('-')) {
      // A top-level key.
      inParams = /^params\s*:\s*$/.test(line);
      const m = /^mode\s*:\s*["']?(session|isolated)["']?\s*(#.*)?$/i.exec(line);
      if (m) mode = m[1]!.toLowerCase() as 'session' | 'isolated';
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

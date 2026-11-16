/**
 * Copy Line with Values: each placeholder's value quoted for the shell the line is pasted into, so
 * a value such as `x; rm -rf ~` stays one word of text and never becomes a command.
 *
 * Local to VS Code for now: core is getting a shared shell-quoting helper on another branch (the
 * app's Copy Line with Values). De-duplicate once both are on main.
 */
import type { ShellKind } from '@md-runbook/core/shellKind';

/** A placeholder as written in a line: `${kind:NAME}` or `${input:NAME:secret}`. */
const PLACEHOLDER_RE = /\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

/** Values that read the same quoted or not, left as they are (`prod`, `eu-west-1`, `v1.2/x`). */
const BASH_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** PowerShell: no leading `-` (a parameter), no `,` (an array) or `@` (splatting). */
const PWSH_SAFE = /^[A-Za-z0-9_./:][A-Za-z0-9_./:-]*$/;
/** cmd has no quoting that holds for all of these: the value is copied as it is, with a warning. */
const CMD_META = /[&|<>^%"]/;

const PWSH_SINGLE = /['‘’‚‛]/;
const PWSH_DOUBLE = /["“”„]/;

type Quoting = 'none' | 'single' | 'double';

const bashSingle = (v: string): string => v.replace(/'/g, "'\\''");

/** How `v` is written where the line is `state` (outside quotes, or inside single or double ones). */
function quoted(v: string, kind: ShellKind, state: Quoting): string {
  if (kind === 'bash') {
    if (state === 'single') return bashSingle(v); // close, an escaped quote, open again
    // In double quotes: close them, the value in single quotes, open them again (no $, `, \ or ! there).
    if (state === 'double') return `"'${bashSingle(v)}'"`;
    return BASH_SAFE.test(v) ? v : `'${bashSingle(v)}'`;
  }
  const pwshSingle = (s: string): string => s.replace(new RegExp(PWSH_SINGLE.source, 'g'), '$&$&');
  if (state === 'single') return pwshSingle(v);
  if (state === 'double') return v.replace(new RegExp(`[\`$]|${PWSH_DOUBLE.source}`, 'g'), '`$&');
  return PWSH_SAFE.test(v) ? v : `'${pwshSingle(v)}'`;
}

/** The quoting state after `text`, starting in `state` (bash: \ escapes; PowerShell: ` escapes, '' and "" stay inside). */
function scan(text: string, kind: ShellKind, state: Quoting): Quoting {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (kind === 'bash') {
      if (state === 'single') {
        if (c === "'") state = 'none';
      } else if (c === '\\') i++;
      else if (state === 'none' && c === "'") state = 'single';
      else if (c === '"') state = state === 'double' ? 'none' : 'double';
      continue;
    }
    if (state === 'single') {
      if (PWSH_SINGLE.test(c)) {
        if (PWSH_SINGLE.test(text[i + 1] ?? '')) i++;
        else state = 'none';
      }
    } else if (c === '`') i++;
    else if (state === 'none' && PWSH_SINGLE.test(c)) state = 'single';
    else if (PWSH_DOUBLE.test(c)) {
      if (state === 'double' && PWSH_DOUBLE.test(text[i + 1] ?? '')) i++;
      else state = state === 'double' ? 'none' : 'double';
    }
  }
  return state;
}

export interface CopiedLine {
  text: string;
  /** Placeholders left as written: no value yet, or a secret. */
  left: string[];
  /** cmd: placeholders whose value has characters cmd reads (& | < > ^ % "): check before pasting. */
  risky: string[];
}

/**
 * The line with the values filled in, each quoted for `kind` where it stands; `value` answers
 * undefined for a placeholder left as written (secrets, values not known yet).
 */
export function lineWithValues(line: string, kind: ShellKind, value: (kind: string, name: string) => string | undefined): CopiedLine {
  const left = new Set<string>();
  const risky = new Set<string>();
  let out = '';
  let state: Quoting = 'none';
  let last = 0;
  for (const m of line.matchAll(PLACEHOLDER_RE)) {
    const at = m.index ?? 0;
    const before = line.slice(last, at);
    if (kind !== 'cmd') state = scan(before, kind, state);
    out += before;
    last = at + m[0].length;
    const v = value(m[1]!, m[2]!);
    if (v === undefined) {
      left.add(m[0]);
      out += m[0];
      continue;
    }
    if (kind === 'cmd') {
      if (CMD_META.test(v)) risky.add(m[0]);
      out += v;
    } else out += quoted(v, kind, state);
  }
  return { text: out + line.slice(last), left: [...left], risky: [...risky] };
}

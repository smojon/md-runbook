/**
 * Copy Line with Values (the app's runbooks/copyLine.ts, VS Code's lineRuns.ts): a command with
 * the values a run would use filled in, for pasting into a terminal. A run never puts a value in
 * the code: it reads it from an environment variable (secrets.ts rewriteRefs), so a value is
 * always one piece of text, never more shell code. A copy keeps that: each value is quoted for the
 * cell's shell, where it stands (outside quotes, in double quotes, in single quotes).
 *
 * - bash/sh: single quotes; in double quotes, the double quotes are closed around them.
 * - PowerShell: single quotes, `'` doubled; in double quotes, `` ` `` before `` ` ``, `$` and `"`.
 * - cmd has no quoting that holds: a value with a metacharacter (`& | < > ^ % ! " ( )`, a line
 *   break) is not filled in, and its reference is listed as left.
 */
import type { RefKind } from './secrets';
import type { ShellKind } from './shellKind';
import { quotePwsh, quoteSh } from './terminalCommand';

const REF_RE = /\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

/** Values that read the same unquoted, in either shell. */
const PLAIN_SH = /^[A-Za-z0-9_.,:/=+@%-]+$/;
const PLAIN_PWSH = /^[A-Za-z0-9_.:/=+-]+$/;
const CMD_META = /[&|<>^%!"()\r\n]/;

type Quote = 'none' | 'single' | 'double';

/** Where each offset of `command` is: outside quotes, or in single or double quotes. */
function quoteStates(command: string, shell: ShellKind): Quote[] {
  const states: Quote[] = [];
  let q: Quote = 'none';
  for (let i = 0; i < command.length; i++) {
    states[i] = q;
    const c = command[i]!;
    if (shell === 'cmd') {
      if (c === '"') q = q === 'double' ? 'none' : 'double';
      else if (c === '^' && q === 'none') states[++i] = q;
      continue;
    }
    const pwsh = shell === 'pwsh';
    const single = pwsh ? /['\u2018\u2019\u201A\u201B]/.test(c) : c === "'";
    const double = pwsh ? /["\u201C\u201D\u201E]/.test(c) : c === '"';
    const escape = pwsh ? c === '`' : c === '\\';
    if (q === 'single') {
      if (single) q = 'none'; // PowerShell's '' reopens at once: the same state again
    } else if (escape) {
      states[++i] = q;
    } else if (q === 'double') {
      if (double) q = 'none';
    } else if (single) q = 'single';
    else if (double) q = 'double';
  }
  return states;
}

/** `value` as `shell` reads it as one piece of text where the state is `q`; undefined: can't (cmd). */
export function quoteValue(value: string, shell: ShellKind, q: Quote = 'none'): string | undefined {
  switch (shell) {
    case 'cmd':
      return CMD_META.test(value) ? undefined : value;
    case 'pwsh':
      if (q === 'single') return value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&');
      if (q === 'double') return value.replace(/[`$"\u201C\u201D\u201E]/g, '`$&');
      return PLAIN_PWSH.test(value) ? value : quotePwsh(value);
    case 'bash':
      if (q === 'single') return value.replace(/'/g, `'\\''`);
      if (PLAIN_SH.test(value)) return value;
      return q === 'double' ? `"${quoteSh(value)}"` : quoteSh(value);
  }
}

/**
 * `command` with the references `value` knows filled in, each quoted for `shell` where it stands.
 * A reference `value` doesn't give (a secret, a value not known yet), or a cmd value with a
 * metacharacter, stays as it is and is listed in `left` (in order, once each).
 */
export function fillQuoted(
  command: string,
  shell: ShellKind,
  value: (kind: RefKind, name: string, secretMod: boolean) => string | undefined,
): { text: string; left: string[] } {
  const states = quoteStates(command, shell);
  const left = new Set<string>();
  const text = command.replace(REF_RE, (whole: string, kind: RefKind, name: string, mod: string | undefined, at: number) => {
    const v = value(kind, name, mod !== undefined);
    const quoted = v === undefined ? undefined : quoteValue(v, shell, states[at] ?? 'none');
    if (quoted !== undefined) return quoted;
    left.add(whole);
    return whole;
  });
  return { text, left: [...left] };
}

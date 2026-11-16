/**
 * Copy Line with Values (the app's runbooks/copyLine.ts, VS Code's lineRuns.ts): a command with
 * the values a run would use filled in, for pasting into a terminal. A run never puts a value in
 * the code: it reads it from an environment variable (secrets.ts rewriteRefs), so a value is
 * always one piece of text, never more shell code. A copy keeps that: each value is quoted for the
 * cell's shell, where it stands (outside quotes, in double quotes, in single quotes).
 *
 * - bash/sh: single quotes; in double quotes, the double quotes are closed around them.
 * - PowerShell: single quotes, `'` doubled; in double quotes, `` ` `` before `` ` ``, `$` and `"`.
 *   A value starting with `-` is quoted (unquoted it would be a parameter name).
 * - cmd has no quoting that holds: a value with a metacharacter (`& | < > ^ % ! " ( )`, a line
 *   break) is not filled in, and its reference is listed as left.
 * - After a command substitution (bash `$(` or a backtick, PowerShell `$(` or `@(`), bash's
 *   `$'…'` or an open `${…}`, or PowerShell's `--%`, the quoting isn't followed here: a reference
 *   there is not filled in, and is listed as left. Before, a value there could end the quotes and
 *   run as code (security review, round 4).
 * - A command with a comment (bash `#` at a word's start; PowerShell `#`, `<#`), a bash heredoc
 *   (`<<`) or a PowerShell here-string (`@"`, `@'`) gets no value at all: the apostrophe of
 *   `# don't` opened a quote that never was, and a heredoc's body isn't quoted (a value with a
 *   line `EOF` ended it). Nor does a reference after the shell's escape character (`\${…}`,
 *   `` `${…} ``, `^${…}`): its quote would be escaped. Refused rather than parsed (round 5).
 */
import type { RefKind } from './secrets';
import type { ShellKind } from './shellKind';
import { quotePwsh, quoteSh } from './terminalCommand';

const REF_RE = /\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

/** Values that read the same unquoted, in either shell. */
const PLAIN_SH = /^[A-Za-z0-9_.,:/=+@%-]+$/;
/** PowerShell: never a leading `-` (a parameter name). */
const PLAIN_PWSH = /^[A-Za-z0-9_.:/=+][A-Za-z0-9_.:/=+-]*$/;
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
    const single = pwsh ? /['‘’‚‛]/.test(c) : c === "'";
    const double = pwsh ? /["“”„]/.test(c) : c === '"';
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

/**
 * Whether the quoting after `before` is beyond quoteStates: in or after a command substitution
 * (its quotes nest), bash's `$'…'` (backslash escapes), an open `${…}` (its word has quoting of its
 * own), PowerShell's `--%` (the rest goes to the program unparsed). Cautious: also when that text
 * is quoted or escaped itself.
 */
function quotingUnknown(before: string, shell: ShellKind): boolean {
  if (shell === 'pwsh') return /[$@]\(|--%/.test(before);
  if (shell !== 'bash') return false;
  if (/\$\(|`|\$'/.test(before)) return true;
  let depth = 0;
  for (const m of before.replace(new RegExp(REF_RE.source, 'g'), '').matchAll(/\$\{|\}/g)) depth = m[0] === '}' ? Math.max(0, depth - 1) : depth + 1;
  return depth > 0;
}

/**
 * Whether `command` has quoting quoteStates doesn't follow anywhere in it: a comment, a bash heredoc
 * or a PowerShell here-string. Cautious: also inside quotes.
 */
function unfollowed(command: string, shell: ShellKind): boolean {
  if (shell === 'bash') return /(?<![^\s;&|()<>'"`])#/.test(command) || command.includes('<<');
  if (shell === 'pwsh') return /(?<![\w$])#|@["“”„'‘’‚‛]/.test(command);
  return false;
}

/** The shell's escape character. */
const ESCAPE: Record<ShellKind, string> = { bash: '\\', pwsh: '`', cmd: '^' };

/** `value` as `shell` reads it as one piece of text where the state is `q`; undefined: can't (cmd). */
export function quoteValue(value: string, shell: ShellKind, q: Quote = 'none'): string | undefined {
  switch (shell) {
    case 'cmd':
      return CMD_META.test(value) ? undefined : value;
    case 'pwsh':
      if (q === 'single') return value.replace(/['‘’‚‛]/g, '$&$&');
      if (q === 'double') return value.replace(/[`$"“”„]/g, '`$&');
      return PLAIN_PWSH.test(value) ? value : quotePwsh(value);
    case 'bash':
      if (q === 'single') return value.replace(/'/g, `'\\''`);
      if (PLAIN_SH.test(value)) return value;
      return q === 'double' ? `"${quoteSh(value)}"` : quoteSh(value);
  }
}

/**
 * `command` with the references `value` knows filled in, each quoted for `shell` where it stands.
 * A reference `value` doesn't give (a secret, a value not known yet), a cmd value with a
 * metacharacter, or one where the quoting isn't known (quotingUnknown) stays as it is and is
 * listed in `left` (in order, once each).
 */
export function fillQuoted(
  command: string,
  shell: ShellKind,
  value: (kind: RefKind, name: string, secretMod: boolean) => string | undefined,
): { text: string; left: string[] } {
  const states = quoteStates(command, shell);
  const refused = unfollowed(command, shell);
  const left = new Set<string>();
  const text = command.replace(REF_RE, (whole: string, kind: RefKind, name: string, mod: string | undefined, at: number) => {
    const unknown = refused || command[at - 1] === ESCAPE[shell] || quotingUnknown(command.slice(0, at), shell);
    const v = unknown ? undefined : value(kind, name, mod !== undefined);
    const quoted = v === undefined ? undefined : quoteValue(v, shell, states[at] ?? 'none');
    if (quoted !== undefined) return quoted;
    left.add(whole);
    return whole;
  });
  return { text, left: [...left] };
}

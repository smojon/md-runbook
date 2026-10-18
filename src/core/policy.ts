/**
 * Command policy for AI-proposed cells: which lines may be approved with one click, which need
 * a closer look, and which can't be approved at all. Policy file `.md-runbook-policy.json`:
 *
 *   { "allow": ["^kubectl\\s+get\\b"], "deny": ["\\|\\s*sh\\b"], "requireTypedConfirmation": true }
 *
 * Patterns are case-insensitive JavaScript regular expressions (case-sensitive when they start
 * with `(?-i)`). A key that is present replaces the built-in list for that key.
 */

import { createHash } from 'node:crypto';

export interface CommandPolicy {
  /** Matched against each command of a line (split at `|`, `;`, `&&`, `||`, `&`). */
  allow: string[];
  /** When set, each command must ALSO match one of these (a workspace policy can only narrow). */
  allowAlso?: string[];
  /** Matched against each whole logical line. */
  deny: string[];
  /** Approving a `review` proposal needs the word `run` typed in. */
  requireTypedConfirmation: boolean;
}

export type Verdict = 'allowed' | 'review' | 'denied';

export interface PolicyResult {
  verdict: Verdict;
  /** Lines matching a deny pattern, with the pattern. */
  denied: { line: string; pattern: string }[];
  /** Command lines no allow pattern covers. */
  unlisted: string[];
  /** Invalid patterns (ignored). */
  errors: string[];
}

const READ_VERBS = 'get|describe|logs|top|events|explain|version|api-resources|api-versions|cluster-info|whoami|status|projects?|config\\s+(view|current-context|get-contexts)|auth\\s+can-i';

export const DEFAULT_ALLOW: string[] = [
  `^(kubectl|oc)(\\s+-{1,2}[\\w-]+(=\\S+|\\s+\\S+)?)*\\s+(${READ_VERBS})\\b`,
  '^helm\\s+(list|ls|status|get|history|show|search|version|template|lint|env)\\b',
  // curl that only reads: no request body, upload, output file, config file or non-GET method.
  '(?-i)^curl\\b(?!.*(\\s-[A-Za-z]*[dDFTOoK]|\\s--(data|form|upload-file|output|config|json)\\b|\\s-[A-Za-z]*X\\s*(?!\\s|GET\\b|HEAD\\b)|\\s--request\\s+(?!\\s|GET\\b|HEAD\\b)))',
  '^(Get|Test|Resolve|Select|Where|Sort|Measure|Format|ConvertTo|ConvertFrom)-\\w+\\b',
  '^Write-(Output|Host)\\b',
  '^(echo|printf|cat|grep|egrep|fgrep|head|tail|jq|ls|dir|pwd|whoami|date|hostname|uname|wc|uniq|cut|tr|id|df|ps|uptime|printenv)\\b',
  '^yq\\b(?!.*\\s-[A-Za-z]*i)',
  '^(env|set)\\s*$',
];

export const DEFAULT_DENY: string[] = [
  // Piping into a shell or interpreter.
  '\\|\\s*(sudo\\s+)?(ba|z|da|k)?sh\\b',
  '\\|\\s*(sudo\\s+)?(python\\d*|perl|ruby|node|pwsh|powershell|cmd)(\\.exe)?\\b',
  '\\b(iex|Invoke-Expression)\\b',
  '\\[scriptblock\\]::create',
  '\\bbase64\\s+(-d|-D|--decode)\\b.*\\|',
  '\\beval\\b',
  '\\b(ba|z|da)?sh\\s+-c\\b',
  '\\b(pwsh|powershell)(\\.exe)?\\b.*\\s-(e|ec|enc|encodedcommand)\\s',
  '\\b(source|\\.)\\s+<\\(',
  '\\brm\\s+(-\\S+\\s+)*/(\\*|\\s|$)',
  '\\b(kubectl|oc)\\b.*\\sdelete\\b',
  '>\\s*/dev/(?!null\\b|stdout\\b|stderr\\b|tty\\b)',
  '\\bmkfs\\b',
  '\\bdd\\b.*\\bof=',
  ':\\(\\)\\s*\\{',
];

export const DEFAULT_POLICY: CommandPolicy = { allow: DEFAULT_ALLOW, deny: DEFAULT_DENY, requireTypedConfirmation: true };

/**
 * A policy file found in the workspace (which anyone who can change the repository controls) may
 * only make `base` stricter: its deny rules are added, its allow list can only narrow the base one,
 * and typed confirmation can't be turned off.
 */
export function restrictPolicy(base: CommandPolicy, workspace: CommandPolicy): CommandPolicy {
  return {
    allow: base.allow,
    allowAlso: workspace.allow.length > 0 ? [...(base.allowAlso ?? []), ...workspace.allow] : base.allowAlso,
    deny: [...base.deny, ...workspace.deny],
    requireTypedConfirmation: base.requireTypedConfirmation || workspace.requireTypedConfirmation,
  };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A policy from file contents; missing or invalid keys keep the defaults. */
export function parsePolicy(json: string): { policy: CommandPolicy; errors: string[] } {
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json.replace(/^﻿/, ''));
  } catch (e) {
    return { policy: DEFAULT_POLICY, errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { policy: DEFAULT_POLICY, errors: ['expected a JSON object'] };
  const d = data as Record<string, unknown>;
  const policy: CommandPolicy = { ...DEFAULT_POLICY };
  for (const key of ['allow', 'deny'] as const) {
    if (d[key] === undefined) continue;
    if (strings(d[key])) policy[key] = d[key];
    else errors.push(`"${key}" must be an array of strings`);
  }
  if (d.requireTypedConfirmation !== undefined) {
    if (typeof d.requireTypedConfirmation === 'boolean') policy.requireTypedConfirmation = d.requireTypedConfirmation;
    else errors.push('"requireTypedConfirmation" must be true or false');
  }
  return { policy, errors };
}

/** Prefix that makes a pattern case-sensitive. */
const CASE_SENSITIVE = '(?-i)';

function compile(patterns: string[], errors: string[]): { re: RegExp; src: string }[] {
  const out: { re: RegExp; src: string }[] = [];
  for (const src of patterns) {
    try {
      const cased = src.startsWith(CASE_SENSITIVE);
      out.push({ re: new RegExp(cased ? src.slice(CASE_SENSITIVE.length) : src, cased ? '' : 'i'), src });
    } catch (e) {
      errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Logical command lines: comments and blank lines dropped, continuations (`\`, `` ` ``, `^`) joined. */
export function commandLines(text: string): string[] {
  const lines: string[] = [];
  let pending = '';
  let inBlock = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('#>');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('<#')) {
      const end = line.indexOf('#>', 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (pending === '' && (line === '' || line.startsWith('#') || line.startsWith('::') || /^rem(\s|$)/i.test(line))) continue;
    const cont = /(\\|`|\^)$/.exec(line);
    if (cont) {
      pending += line.slice(0, -1) + ' ';
      continue;
    }
    lines.push((pending + line).trim());
    pending = '';
  }
  if (pending.trim() !== '') lines.push(pending.trim());
  return lines.filter((l) => l !== '');
}

/** Harmless redirections that don't write files. */
const HARMLESS_REDIRECT = /\s*(\d?>&\d|\d?>\s*\/dev\/null\b|\d?>\s*\$null\b|\d?>\s*nul\b)/gi;

/** A command line is allowed when every command in it matches an allow pattern (and `also`, if given). */
function lineAllowed(line: string, allow: { re: RegExp }[], also?: { re: RegExp }[]): boolean {
  const cleaned = line.replace(HARMLESS_REDIRECT, '');
  // Command substitution, process substitution, file redirection and injected secrets always need review.
  if (/\$\(|<\(|`|>|\$\{(secret|input):/i.test(cleaned)) return false;
  const parts = cleaned.split(/\|\||&&|[|;&]/).map((s) => s.trim()).filter((s) => s !== '');
  return parts.length > 0 && parts.every((p) => allow.some(({ re }) => re.test(p)) && (!also || also.some(({ re }) => re.test(p))));
}

/** Evaluate the whole text of a cell against a policy. */
export function evaluatePolicy(text: string, policy: CommandPolicy): PolicyResult {
  const errors: string[] = [];
  const allow = compile(policy.allow, errors);
  const deny = compile(policy.deny, errors);
  const also = policy.allowAlso ? compile(policy.allowAlso, errors) : undefined;
  const denied: PolicyResult['denied'] = [];
  const unlisted: string[] = [];
  for (const line of commandLines(text)) {
    const hit = deny.find(({ re }) => re.test(line));
    if (hit) denied.push({ line, pattern: hit.src });
    else if (!lineAllowed(line, allow, also)) unlisted.push(line);
  }
  const verdict: Verdict = denied.length > 0 ? 'denied' : unlisted.length > 0 ? 'review' : 'allowed';
  return { verdict, denied, unlisted, errors };
}

/** Fingerprint of a cell's code, independent of line endings. */
export function codeHash(code: string): string {
  return createHash('sha256').update(code.replace(/\r\n?/g, '\n'), 'utf8').digest('hex').slice(0, 32);
}

/** Fence info without the approval stamps and the `proposed` flag (what an approval covers). */
export function approvalInfo(info: string): string {
  return info
    .replace(/(^|\s)approved-(?:by|at)=("[^"]*"|'[^']*'|\S*)/gi, ' ')
    .replace(/(^|\s)proposed(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What an approval is bound to: the code, the fence options (cwd=, env.X=, timeout=, by=, …) and
 * the runbook it lives in. Changing any of them needs a new approval.
 */
export function approvalHash(code: string, info: string, runbook: string): string {
  return codeHash(`${approvalInfo(info)}\u0000${runbook}\u0000${code.replace(/\r\n?/g, '\n')}`);
}

export interface ApprovalFacts {
  /** Current code of the cell. */
  code: string;
  /** Current fence info string. */
  info: string;
  /** The runbook's path (approvals don't carry over to other files). */
  runbook: string;
  /** Code as loaded from the file. */
  loadedCode: string;
  /** Hash stored when the cell was approved in this editor session. */
  approvedHash?: string;
  /** Code hashes approved on this machine. */
  approvedHere: (hash: string) => boolean;
  resetOnEdit: boolean;
  /** Honour approvals written in the file by others (or by anything else that edits the file). */
  trustFileApprovals: boolean;
}

export type ApprovalStatus = { state: 'none' } | { state: 'approved' } | { state: 'proposed'; why: 'proposed' | 'changed' | 'unverified' };

/** Whether a cell may run, given its fence state and what is known about its approval. */
export function approvalStatus(state: 'none' | 'proposed' | 'approved', f: ApprovalFacts): ApprovalStatus {
  if (state === 'none') return { state: 'none' };
  if (state === 'proposed') return { state: 'proposed', why: 'proposed' };
  const h = approvalHash(f.code, f.info, f.runbook);
  if (f.approvedHash === h || f.approvedHere(h)) return { state: 'approved' };
  const edited = f.approvedHash !== undefined || codeHash(f.code) !== codeHash(f.loadedCode);
  if (edited && f.resetOnEdit) return { state: 'proposed', why: 'changed' };
  // Approved in this session and edited since, with resetOnEdit off.
  if (f.approvedHash !== undefined) return { state: 'approved' };
  return f.trustFileApprovals ? { state: 'approved' } : { state: 'proposed', why: 'unverified' };
}

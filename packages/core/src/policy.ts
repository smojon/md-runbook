/**
 * Command policy for AI-proposed cells: which lines may be approved with one click, which need
 * a closer look, and which can't be approved at all. Policy file `.md-runbook-policy.json`:
 *
 *   { "allow": ["^kubectl\\s+get\\b"], "deny": ["\\|\\s*sh\\b"], "requireTypedConfirmation": true }
 *
 * Patterns are case-insensitive JavaScript regular expressions (case-sensitive when they start
 * with `(?-i)`). A key that is present replaces the built-in list for that key.
 */

import { sha256Hex } from './sha256';
import { stripApprovalTokens } from './proposal';

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

export const DEFAULT_ALLOW: string[] = [
  // kubectl / oc: the verb and flags are checked by the built-in rules (kubeArgsReadOnly).
  '^(kubectl|oc)\\s+\\S',
  '^helm\\s+(list|ls|status|get|history|show|search|version|template|lint|env)\\b',
  // curl that only reads: no request body, upload, output file, config file or non-GET method.
  '(?-i)^curl\\b(?!.*(\\s-[A-Za-z]*[dDFTOoK]|\\s--(data|form|upload-file|output|config|json)\\b|\\s-[A-Za-z]*X\\s*(?!\\s|GET\\b|HEAD\\b)|\\s--request\\s+(?!\\s|GET\\b|HEAD\\b)))',
  // Invoke-RestMethod / Invoke-WebRequest GET: no method, body, in/out file, form or credentials.
  '^(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\\b(?!.*\\s-(me|b|o|inf|f|cu|cred|sessionv|websession|cert|token|auth)\\w*)',
  '^(Get|Test|Resolve|Select|Where|Sort|Measure|Format|ConvertTo|ConvertFrom)-\\w+\\b',
  '^(ForEach-Object|foreach|%|Where-Object|where|\\?|Select-Object|select|Sort-Object|Format-Table|ft|Format-List|fl|Out-String|Select-String|sls|measure)(\\s|$)',
  '^Write-(Output|Host)\\b',
  '^(echo|printf|cat|type|grep|egrep|fgrep|findstr|head|tail|jq|ls|dir|pwd|whoami|date|hostname|uname|wc|uniq|cut|tr|id|df|ps|uptime|nslookup|dig|host)\\b',
  '^sort\\b(?!.*\\s(-o|--output)\\b)',
  // ping only with a count (-c on Linux/macOS, -n on Windows) and not forever (-t).
  '^ping\\b(?=.*\\s-[cn]\\s*\\d+)(?!.*\\s-t\\b)',
  '^openssl\\s+(x509\\b(?=.*\\s-noout\\b)|s_client\\b)(?!.*\\s-(out|sess_out|keylogfile|msgfile|key|cert)\\b)',
  '^yq\\b(?!.*\\s(-[A-Za-z]*i|--inplace)\\b)',
];

/** kubectl / oc verbs that only read (the first word after the global flags). */
const KUBE_READ_VERBS = new Set(['get', 'describe', 'logs', 'top', 'events', 'explain', 'version', 'api-resources', 'api-versions', 'cluster-info', 'whoami', 'status', 'projects', 'config', 'auth', 'adm']);

/** Flags of kubectl / oc / helm that take a value as the next word (unless written `--flag=value`). */
const KUBE_VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--cluster', '--user', '--as', '--as-group', '--as-uid', '-l', '--selector', '-o', '--output',
  '--kubeconfig', '--token', '--server', '-s', '-c', '--container', '--request-timeout', '--certificate-authority', '--client-certificate',
  '--client-key', '--tls-server-name', '--cache-dir', '--log-file', '-v', '--v', '--field-selector', '--sort-by', '--template', '--since',
  '--tail', '--kube-context', '--kube-token', '--kube-as-user', '--kube-as-group', '--kube-apiserver', '--kube-ca-file', '--revision',
]);

/** Flags that change whose credentials (or which server) a kubectl / oc / helm command uses. */
const KUBE_CREDENTIAL_FLAGS = new Set([
  '--kubeconfig', '--token', '--server', '-s', '--as', '--as-group', '--as-uid', '--client-certificate', '--client-key', '--username',
  '--password', '--kube-token', '--kube-as-user', '--kube-as-group', '--kube-apiserver', '--show-token',
]);

/** Words that change something (or open a session) anywhere in a kubectl / oc / helm command. */
const KUBE_MUTATING = new Set([
  'scale', 'patch', 'apply', 'create', 'replace', 'edit', 'set', 'label', 'annotate', 'drain', 'cordon', 'uncordon', 'taint', 'rollout',
  'exec', 'rsh', 'rsync', 'attach', 'debug', 'cp', 'port-forward', 'proxy', 'run', 'expose', 'autoscale', 'adm', 'login', 'logout',
  'project', 'new-project', 'new-app', 'new-build', 'start-build', 'import-image', 'tag', 'import', 'upgrade', 'install', 'rollback',
  'uninstall', 'delete', 'certificate', 'plugin', 'kustomize', 'wait',
]);

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

/** Which shell's quoting rules apply when a line is split into commands. */
export type PolicyShell = 'bash' | 'pwsh' | 'cmd';

interface ScannedLine {
  /** Commands, split at unquoted `|`, `||`, `&&`, `;`, `&` outside `{…}` blocks (original text). */
  parts: string[];
  /** The line with the contents of quoted strings blanked out. */
  skeleton: string;
  /** Contents of outermost `{…}` blocks (script blocks, brace groups), not `${VAR}` expansions. */
  blocks: string[];
}

/**
 * Quote-aware split of one command line. Escapes are honoured (bash `\`, cmd `^`) so an escaped
 * quote can't hide a separator; cmd has no single quotes. When in doubt the line is split more,
 * never less, which only makes it more likely to need review.
 */
function scanLine(line: string, shell: PolicyShell): ScannedLine {
  const parts: string[] = [];
  const blocks: string[] = [];
  let skeleton = '';
  let cur = '';
  let quote: string | undefined;
  const opens: { at: number; isVar: boolean }[] = [];
  const escape = shell === 'cmd' ? '^' : shell === 'bash' ? '\\' : undefined;
  const push = (): void => {
    if (cur.trim() !== '') parts.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      // Inside double quotes bash still honours \" (cmd and PowerShell have no such escape here).
      if (shell === 'bash' && quote === '"' && c === '\\' && i + 1 < line.length) {
        cur += c + line[++i]!;
        skeleton += '  ';
        continue;
      }
      cur += c;
      if (c === quote) {
        quote = undefined;
        skeleton += c;
      } else skeleton += ' ';
      continue;
    }
    if (c === escape && i + 1 < line.length) {
      cur += c + line[++i]!;
      skeleton += '  ';
      continue;
    }
    if (c === '"' || (c === "'" && shell !== 'cmd')) {
      quote = c;
      cur += c;
      skeleton += c;
      continue;
    }
    skeleton += c;
    if (c === '{') opens.push({ at: i, isVar: line[i - 1] === '$' });
    else if (c === '}' && opens.length > 0) {
      const o = opens.pop()!;
      if (opens.length === 0 && !o.isVar) blocks.push(line.slice(o.at + 1, i));
    }
    if (opens.length === 0 && (c === '|' || c === ';' || c === '&')) {
      if ((c === '|' || c === '&') && line[i + 1] === c) i++;
      push();
      continue;
    }
    cur += c;
  }
  // An unclosed block: check what follows it as a block too.
  const open = opens.find((o) => !o.isVar);
  if (open) blocks.push(line.slice(open.at + 1));
  push();
  return { parts, skeleton, blocks };
}

/** Words of a command with quotes removed (quote-aware). */
function words(part: string, shell: PolicyShell): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (const c of part) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || (c === "'" && shell !== 'cmd')) {
      quote = c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (cur !== '' || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur !== '' || has) out.push(cur);
  return out;
}

/** The command with quotes removed and `.exe` dropped from the command name (kubectl.exe → kubectl). */
const normalize = (part: string, shell: PolicyShell): string => words(part, shell).join(' ').replace(/^(\S+?)\.exe(?=\s|$)/i, '$1');

/**
 * Lines that read credentials or the environment: env dumps, `$env:` / `%VAR%` reads of
 * secret-looking variables, kubeconfig / cloud credential / SSH / .env files, tokens.
 * Matched against the line as written and with quotes removed.
 */
const SENSITIVE: RegExp[] = [
  /\benv:/i, // $env:X, ${env:X}, Get-ChildItem env:, dir env:
  /\[(System\.)?Environment\]::/i,
  /\/proc\/\S*environ/i,
  /[$%!]\{?\w*?(token|secret|passw(or)?d|api_?key|access_?key|private_?key|credential)/i,
  /(^|[\s/\\'"=:~])\.(kube|ssh|aws|azure|docker|gnupg|netrc|git-credentials|pgpass|npmrc|pypirc)\b/i,
  /\.config[\\/]gcloud/i,
  /kubeconfig/i,
  /credential/i,
  /(^|[\s/\\'"=:])\.env(\.[\w-]+)?(?=$|[\s'"/;|&)])/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
  /--show-token\b/i,
];

/** Commands that print the whole environment (or shell variables). */
const ENV_DUMP = /^(printenv|env|set|export|declare|typeset|compgen|getenv|Get-Variable|gv|variable)(?=\s|$)/i;

/** Per-command rules on top of the allowlist (follow/watch modes, setting the clock, writes). */
const COMMAND_REVIEW: RegExp[] = [
  /^tail\b.*\s(-[a-z]*f|--follow)/i,
  /^(Get-Content|gc|cat|type)\b.*\s-w(a(it?)?)?\b/i,
  /^date\b.*\s(-[a-z]*s|--set)/i,
  // Windows PowerShell 5.1: curl is Invoke-WebRequest, whose parameters write or send data.
  /^curl\b.*\s-(me\w*|body|inf\w*|outf\w*|form|cred\w*|websession|sessionvariable)\b/i,
];

/** kubectl / oc / helm: the first word after the global flags must be a read verb, and no word may change anything. */
function kubeArgsReadOnly(w: string[]): boolean {
  const name = (w[0] ?? '').toLowerCase();
  if (name !== 'kubectl' && name !== 'oc' && name !== 'helm') return true;
  const positional: string[] = [];
  const flags: string[] = [];
  let output: string | undefined;
  for (let i = 1; i < w.length; i++) {
    const word = w[i]!;
    if (!word.startsWith('-') || word === '-') {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf('=');
    const flag = eq < 0 ? word : word.slice(0, eq);
    let value = eq < 0 ? undefined : word.slice(eq + 1);
    if (KUBE_CREDENTIAL_FLAGS.has(flag.toLowerCase())) return false;
    if (/^(-w|--watch|--watch-only|--follow)$/i.test(flag)) return false;
    if (eq < 0 && KUBE_VALUE_FLAGS.has(flag)) value = w[++i] ?? '';
    if (/^-o\S/.test(flag)) value = flag.slice(2);
    if (flag === '-o' || flag === '--output') output = value;
    flags.push(flag);
  }
  if (name === 'helm') return !positional.some((p) => KUBE_MUTATING.has(p.toLowerCase()));
  const [verb, sub, sub2] = positional;
  if (verb === undefined || !KUBE_READ_VERBS.has(verb)) return false;
  if (verb === 'config') {
    if (!['view', 'current-context', 'get-contexts'].includes(sub ?? '')) return false;
    if (flags.some((f) => /^--(raw|flatten)$/.test(f))) return false;
  }
  if (verb === 'auth' && sub !== 'can-i' && sub !== 'whoami') return false;
  if (verb === 'adm' && sub !== 'top' && !(sub === 'policy' && sub2 === 'who-can')) return false;
  if (verb === 'whoami' && flags.some((f) => f === '-t')) return false;
  if (verb === 'logs' && flags.some((f) => /^-[a-z]*f$/.test(f))) return false;
  if (verb === 'get') {
    const secrets = positional.slice(1).some((p) => /(^|,)secrets?(\/|,|$)/i.test(p));
    if (secrets && ((output !== undefined && /^(ya?ml|json|jsonpath|go-template|template|custom-columns)/i.test(output)) || flags.includes('--template'))) return false;
  }
  // `auth can-i create pods` and `adm policy who-can patch pods` name verbs as arguments.
  if ((verb === 'auth' && sub === 'can-i') || verb === 'adm' && sub === 'policy') return true;
  const rest = verb === 'adm' ? positional.slice(2) : positional.slice(1);
  return !rest.some((p) => KUBE_MUTATING.has(p.toLowerCase()));
}

interface Compiled {
  allow: { re: RegExp }[];
  also?: { re: RegExp }[];
}

/** One command (a part of a line, or a statement in a script block). */
function commandAllowed(part: string, c: Compiled, shell: PolicyShell, inBlock: boolean): boolean {
  const w = words(part, shell);
  const cmd = normalize(part, shell);
  const skeleton = scanLine(part, shell).skeleton;
  if (shell === 'pwsh' || inBlock) {
    // PowerShell: `$name = 'literal'`, and expressions like `$_.Status -eq 'Running'` in script blocks.
    if (/^\$[A-Za-z_]\w*\s*=\s*('[^']*'|"[^"$`]*"|-?\d+(\.\d+)?)$/.test(part)) return true;
    if (part.startsWith('$') && !/[(=&@]/.test(skeleton)) return true;
  }
  if (ENV_DUMP.test(cmd) || COMMAND_REVIEW.some((re) => re.test(cmd))) return false;
  if (!kubeArgsReadOnly(w.map((x, i) => (i === 0 ? x.replace(/\.exe$/i, '') : x)))) return false;
  if (/^uniq$/i.test(w[0] ?? '') && w.slice(1).filter((x) => !x.startsWith('-')).length >= 2) return false; // uniq IN OUT writes OUT
  return c.allow.some(({ re }) => re.test(cmd)) && (!c.also || c.also.some(({ re }) => re.test(cmd)));
}

/** A command line is allowed when every command in it matches an allow pattern (and `also`, if given). */
function lineAllowed(line: string, c: Compiled, shell: PolicyShell, inBlock = false, depth = 0): boolean {
  if (depth > 8) return false;
  const cleaned = line.replace(HARMLESS_REDIRECT, '');
  // Command substitution, process substitution and injected secrets always need review.
  if (/\$\(|<\(|`|\$\{(secret|input|out):/i.test(cleaned)) return false;
  const scan = scanLine(cleaned, shell);
  // Redirection to a file (outside quotes).
  if (scan.skeleton.includes('>')) return false;
  const plain = words(cleaned, shell).join(' ');
  if (SENSITIVE.some((re) => re.test(cleaned) || re.test(plain))) return false;
  // Script blocks / brace groups: every statement inside must be allowed too.
  for (const b of scan.blocks) {
    const inner = scanLine(b, shell).parts;
    if (!inner.every((s) => lineAllowed(s, c, shell, true, depth + 1))) return false;
  }
  return scan.parts.length > 0 && scan.parts.every((p) => commandAllowed(stripBlocks(p), c, shell, inBlock));
}

/** A command with its `{…}` blocks (already checked) replaced by `{}`. */
function stripBlocks(part: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i]!;
    if (ch === '{' && part[i - 1] !== '$') {
      if (depth++ === 0) out += '{';
    } else if (ch === '}' && depth > 0) {
      if (--depth === 0) out += '}';
    } else if (depth === 0) out += ch;
  }
  return out + (depth > 0 ? '}' : '');
}

/**
 * Evaluate the whole text of a cell against a policy. `shell` picks the quoting rules used to
 * split lines into commands (default bash). Besides the policy's own patterns, built-in rules
 * always send to review: reading the environment or credential files, kubectl / oc / helm commands
 * that are not plainly read-only, follow/watch modes, and file redirections.
 */
export function evaluatePolicy(text: string, policy: CommandPolicy, shell: PolicyShell = 'bash'): PolicyResult {
  const errors: string[] = [];
  const allow = compile(policy.allow, errors);
  const deny = compile(policy.deny, errors);
  const also = policy.allowAlso ? compile(policy.allowAlso, errors) : undefined;
  const denied: PolicyResult['denied'] = [];
  const unlisted: string[] = [];
  for (const line of commandLines(text)) {
    const plain = words(line, shell).join(' ');
    const hit = deny.find(({ re }) => re.test(line) || re.test(plain));
    if (hit) denied.push({ line, pattern: hit.src });
    else if (!lineAllowed(line, { allow, also }, shell)) unlisted.push(line);
  }
  const verdict: Verdict = denied.length > 0 ? 'denied' : unlisted.length > 0 ? 'review' : 'allowed';
  return { verdict, denied, unlisted, errors };
}

/** Fingerprint of a cell's code, independent of line endings. */
export function codeHash(code: string): string {
  return sha256Hex(code.replace(/\r\n?/g, '\n')).slice(0, 32);
}

/** Fence info without the approval stamps and the `proposed` flag (what an approval covers). */
export function approvalInfo(info: string): string {
  // Whole tokens only: a quoted reason that mentions "proposed" is part of what was approved.
  return stripApprovalTokens(info).replace(/\s+/g, ' ').trim();
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

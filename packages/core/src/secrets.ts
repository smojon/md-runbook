/**
 * Variable references in cell source (`${secret:NAME}`, `${input:NAME}`, `${param:NAME}`,
 * `${out:NAME}` for a value captured from an earlier cell's output), runbook
 * parameters from front matter, and `.env` files. Values never go into the script text: each
 * reference is rewritten to the shell's own environment variable syntax and the value is passed
 * in the environment.
 */

import { KUBE_CONTEXT_MODES, KubeContextMode, isKubeContextValue } from './kubeContext';
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

/** `source` with each reference replaced by what `fn` returns for it (`:secret` only counts on inputs). */
export function replaceRefs(source: string, fn: (kind: RefKind, name: string) => string): string {
  return source.replace(REF_RE, (whole, kind: RefKind, name: string, mod: string | undefined) => (mod && kind !== 'input' ? whole : fn(kind, name)));
}

/**
 * `source` as it will run, for a confirmation and its risky patterns: each placeholder whose value
 * is known and not secret filled in; secret ones, and those without a value, left as written.
 */
export function fillShown(source: string, value: (ref: VarRef) => { value: string; secret: boolean } | undefined): string {
  let refs: Map<string, VarRef>;
  try {
    refs = new Map(findRefs(source).map((r) => [r.name, r]));
  } catch {
    return source; // a name used as two kinds: the run reports it
  }
  return source.replace(REF_RE, (whole, _kind: RefKind, name: string, mod: string | undefined) => {
    const ref = refs.get(name);
    if (!ref || ref.secret || (mod && ref.kind !== 'input')) return whole;
    const v = value(ref);
    return v && !v.secret ? v.value : whole;
  });
}

/** Whether `source` has a placeholder that may be filled in for people to see (not a secret one). */
export function hasShownRefs(source: string): boolean {
  try {
    return findRefs(source).some((r) => !r.secret);
  } catch {
    return false;
  }
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
  /** The item's ` # comment`, without its "One of: …" part. */
  description?: string;
  /** The values allowed, from a trailing "One of: a, b, c" in the comment. */
  choices?: string[];
}

/**
 * A parameter's comment as a description and choices: a trailing "One of: a, b, c" (any case, up
 * to the end or a closing period, maybe in parentheses; `, or` and ` or ` also separate) gives
 * the choices, the rest the description.
 */
export function paramComment(comment: string): { description?: string; choices?: string[] } {
  const text = comment.trim();
  // A period ends the list only before a space or the end, so `1.2` can be a choice.
  const m = /(?:^|\s|\()one of:\s*((?:[^.()]|\.(?=\S))*?)\s*\)?\s*\.?\s*$/i.exec(text);
  const choices = m
    ? [
        ...new Set(
          m[1]!
            .split(/\s*,\s*(?:or\s+)?|\s+or\s+/i)
            .map((c) => unquote(c.trim()))
            .filter((c) => c !== ''),
        ),
      ]
    : [];
  if (!m || choices.length === 0) return text !== '' ? { description: text } : {};
  const description = text.slice(0, m.index).replace(/[\s,;:(-]+$/, '');
  return { ...(description !== '' ? { description } : {}), choices };
}

/**
 * Why `value` can't be the value of the parameter `p`: not one of its choices ("One of: a, b").
 * Checked wherever the value comes from (a box, a link, a call, --param, the default).
 */
export function choiceProblem(p: Pick<RunbookParam, 'name' | 'choices'> | undefined, value: string): string | undefined {
  if (!p?.choices || p.choices.includes(value)) return undefined;
  const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value;
  return `\${param:${p.name}} is ${JSON.stringify(shown)}, not one of its choices: ${p.choices.join(', ')}`;
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
  /** `incident:`: the incident this run record belongs to (`INC-1234`); implies `evidence`. */
  incident?: string;
  /** `severity:` of the incident, as written (`SEV2`, `P1`). */
  severity?: string;
  /** `evidence: true` (or an incident): every run records who ran it and where, and every attempt is kept. */
  evidence?: boolean;
  /** `drill: true`: the record is of a drill or exercise, not a real incident (the report says so). */
  drill?: boolean;
  /** `practice:` the host (by its name in the app) every cell runs on in a drill, whatever host= says. */
  practice?: string;
  /** `rto:` in seconds (`30m`, `1h`, `90s`): the target a drill or recovery is measured against. */
  rtoSeconds?: number;
  /** `kube-context:` the Kubernetes context its cells run against, or `${param:NAME}` (kubeContext.ts); a cell's kube-context= wins. */
  kubeContext?: string;
  /** `kube-context-mode:` `check` (the default: kubectl's current context must be it) or `pin` (md-runbook makes it the cell's). */
  kubeContextMode?: KubeContextMode;
  /** `git-bash-path-conversion: off`: on Windows, Git Bash doesn't rewrite POSIX-looking arguments (node/runbookEnv.ts). */
  gitBashPathConversion?: 'on' | 'off';
  /**
   * `manual-steps:` what Run All does at an unticked checklist item (`- [ ]`): `pause` (the default:
   * it waits for you to tick it, skip it or stop) or `continue` (the items are reminders).
   */
  manualSteps?: 'pause' | 'continue';
  /**
   * `env:` variables for every cell run on this machine (VS Code and the command line), below a
   * cell's own `env.NAME=` (node/runbookEnv.ts). Not used on an SSH host: the front matter isn't signed.
   */
  env?: Record<string, string>;
  /**
   * `report-runs:` where every client sends a run summary at the end of a run (runReport.ts): an
   * https address (http only for localhost). Absent when missing or not such an address (lint says so).
   */
  reportRuns?: string;
  /** `report-runs-required: true`: the run doesn't start unless it may be reported (only honoured when signed and trusted). */
  reportRunsRequired?: boolean;
  /** `report-runs-signed: true`: the summary must be signed with the runner's key (only honoured when signed and trusted). */
  reportRunsSigned?: boolean;
  /** `report-runs-token: ${secret:NAME}`: the secret's NAME, sent as a bearer token. A literal token is ignored (lint error). */
  reportRunsToken?: string;
  /** `prose:` the prose checks of lint (prose.ts): `on` (the default: info), `strict` (warnings) or `off`. */
  prose?: 'on' | 'strict' | 'off';
}

/**
 * Why `url` can't be a run report address, or undefined: https only, http only for localhost, no
 * user name or password in it, no spaces. Without URL (the app's runtimes differ): by pattern.
 */
export function reportAddressProblem(url: string): string | undefined {
  const m = /^([a-z]+):\/\/([^/?#\s]*)([/?#][^\s]*)?$/i.exec(url);
  if (!m) return 'not an address (expected https://host/path)';
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if (authority.includes('@')) return 'no user name or password in the address (use report-runs-token: ${secret:NAME})';
  const host = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!host || host[1] === '' || host[1]!.startsWith('.') || host[1]!.endsWith('-')) return `"${authority}" is not a host name`;
  if (scheme === 'https') return undefined;
  if (scheme === 'http') return isLocalHost(host[1]!) ? undefined : 'http is only for localhost: use https';
  return `${scheme}: is not https`;
}

const isLocalHost = (host: string): boolean => /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(host);

/**
 * A front matter value as written, quoted (`"a # b"`, `'it''s'`) or bare, and its trailing
 * ` # comment` (a `#` inside quotes, or with no space before it, is part of the value).
 */
function scalarAndComment(raw: string): { value: string; comment?: string } {
  const v = raw.trim();
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#(.*))?$/.exec(v);
  if (quoted) return { value: unquote(quoted[1]!), ...(quoted[2] !== undefined ? { comment: quoted[2].trim() } : {}) };
  if (v.startsWith('#')) return { value: '', comment: v.slice(1).trim() };
  const c = /\s+#(.*)$/.exec(v);
  return c ? { value: v.slice(0, c.index), comment: c[1]!.trim() } : { value: v };
}

/** A front matter value as written, a trailing ` # comment` dropped. */
function scalar(raw: string): string {
  return scalarAndComment(raw).value;
}

/** An `env:` entry: an indented `NAME: value` (`NAME:` alone is the empty string). */
export const FRONT_MATTER_ENV_ENTRY = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s+(.*?))?\s*$/;

/** `30m`, `1h30m`, `90s`, `45` (seconds) as seconds; undefined when it isn't a duration. */
export function parseDurationSeconds(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(t);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * `params:`, `mode:`, `timeout:`, `cwd:`, `shell:`, `incident:`, `severity:`, `evidence:`, `rto:`, `kube-context:`,
 * `kube-context-mode:`, `git-bash-path-conversion:` and `env:` (indented `NAME: value` lines) from
 * YAML-style front matter (`---` ... `---`
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
  let incident: string | undefined;
  let severity: string | undefined;
  let evidence: boolean | undefined;
  let rtoSeconds: number | undefined;
  let practice: string | undefined;
  let drill: boolean | undefined;
  let kubeContext: string | undefined;
  let kubeContextMode: KubeContextMode | undefined;
  let gitBashPathConversion: 'on' | 'off' | undefined;
  let manualSteps: 'pause' | 'continue' | undefined;
  let reportRuns: string | undefined;
  let reportRunsRequired: boolean | undefined;
  let reportRunsSigned: boolean | undefined;
  let reportRunsToken: string | undefined;
  let prose: 'on' | 'strict' | 'off' | undefined;
  // No prototype: a variable named constructor or __proto__ is a plain entry.
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  let inParams = false;
  let inEnv = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(---|\.\.\.)\s*$/.test(line)) {
      return {
        params,
        ...(mode ? { mode } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(shell ? { shell } : {}),
        ...(incident ? { incident } : {}),
        ...(severity ? { severity } : {}),
        ...(evidence || incident ? { evidence: true } : {}),
        ...(rtoSeconds !== undefined ? { rtoSeconds } : {}),
        ...(practice ? { practice } : {}),
        ...(drill ? { drill } : {}),
        ...(kubeContext ? { kubeContext } : {}),
        ...(kubeContextMode ? { kubeContextMode } : {}),
        ...(gitBashPathConversion ? { gitBashPathConversion } : {}),
        ...(manualSteps ? { manualSteps } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(reportRuns ? { reportRuns } : {}),
        ...(reportRunsRequired ? { reportRunsRequired } : {}),
        ...(reportRunsSigned ? { reportRunsSigned } : {}),
        ...(reportRunsToken ? { reportRunsToken } : {}),
        ...(prose ? { prose } : {}),
      };
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line) && !line.startsWith('-')) {
      // A top-level key.
      inParams = /^params\s*:\s*$/.test(line);
      inEnv = /^env\s*:\s*(#.*)?$/i.test(line);
      const m = /^mode\s*:\s*["']?(session|isolated)["']?\s*(#.*)?$/i.exec(line);
      if (m) mode = m[1]!.toLowerCase() as 'session' | 'isolated';
      const t = /^timeout\s*:\s*["']?(\d+(?:\.\d+)?)s?["']?\s*(#.*)?$/i.exec(line);
      if (t) timeoutSeconds = Number(t[1]);
      const c = /^cwd\s*:\s*(.*?)\s*$/i.exec(line);
      if (c && c[1] !== '') cwd = unquote(c[1]!.replace(/\s+#.*$/, ''));
      const sh = /^shell\s*:\s*(.*?)\s*(#.*)?$/i.exec(line);
      if (sh) {
        const { shells } = parseShells(sh[1]!);
        // A second `shell:` line adds what the first didn't say; the first one counts (lint warns).
        if (shells.unix || shells.powershell) shell = { ...shells, ...shell };
      }
      const value = (key: string): string | undefined => {
        const v = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, 'i').exec(line)?.[1];
        return v === undefined || v === '' ? undefined : unquote(v.replace(/\s+#.*$/, ''));
      };
      incident = value('incident') ?? incident;
      severity = value('severity') ?? severity;
      practice = value('practice') ?? practice;
      const dr = value('drill');
      if (dr !== undefined) drill = /^(true|yes|on)$/i.test(dr);
      const ev = value('evidence');
      if (ev !== undefined) evidence = /^(true|yes|on)$/i.test(ev);
      const rto = value('rto');
      if (rto !== undefined) rtoSeconds = parseDurationSeconds(rto) ?? rtoSeconds;
      const kc = value('kube-context');
      // A name kubectl can't have would refuse every cell: ignored (lint says so). `${param:NAME}`
      // is filled in when the cell runs (resolveKubeContext).
      if (kc !== undefined && isKubeContextValue(kc)) kubeContext = kc;
      const km = value('kube-context-mode')?.toLowerCase();
      if (km !== undefined && (KUBE_CONTEXT_MODES as readonly string[]).includes(km)) kubeContextMode = km as KubeContextMode;
      const pc = value('git-bash-path-conversion')?.toLowerCase();
      if (pc === 'on' || pc === 'off') gitBashPathConversion = pc;
      const ms = value('manual-steps')?.toLowerCase();
      if (ms === 'pause' || ms === 'continue') manualSteps = ms;
      const pr = value('prose')?.toLowerCase();
      if (pr === 'on' || pr === 'strict' || pr === 'off') prose = pr;
      // The first one counts (a second could otherwise send the summary elsewhere unnoticed).
      const rr = value('report-runs');
      if (rr !== undefined && reportRuns === undefined && reportAddressProblem(rr) === undefined) reportRuns = rr;
      const rq = value('report-runs-required');
      if (rq !== undefined) reportRunsRequired = /^(true|yes|on)$/i.test(rq);
      const rs = value('report-runs-signed');
      if (rs !== undefined) reportRunsSigned = /^(true|yes|on)$/i.test(rs);
      // Only a reference to a secret: never a literal token in the file (lint errors on one).
      const rt = /^report-runs-token\s*:\s*["']?\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}["']?\s*(#.*)?$/i.exec(line);
      if (rt) reportRunsToken = rt[1];
      continue;
    }
    if (inEnv) {
      const entry = FRONT_MATTER_ENV_ENTRY.exec(line);
      // The first one counts (lint warns about the others and about lines that are no entry).
      if (entry && !(entry[1]! in env)) env[entry[1]!] = scalar(entry[2] ?? '');
      continue;
    }
    if (!inParams) continue;
    // `- NAME`, `- NAME: default`, each with an optional ` # comment` (the default as any scalar:
    // quoted, or bare up to the comment). The comment is the description, and its trailing
    // "One of: a, b" the choices (paramComment).
    const item = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:(?:\s+(.*?)|\s*)|\s+(#.*)|)\s*$/.exec(line);
    if (!item) continue;
    const name = item[1]!;
    if (params.some((p) => p.name === name)) continue;
    const { value, comment } = scalarAndComment(item[2] ?? item[3] ?? '');
    // `- B: ""` is an empty default (a quoted value, even empty); `- B:` alone is none.
    const quoted = /^["']/.test(item[2]?.trim() ?? '');
    params.push({ name, ...(value !== '' || quoted ? { default: value } : {}), ...(comment !== undefined ? paramComment(comment) : {}) });
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

/**
 * Adds a parsed `.env` file to a cell's environment. It goes over `mdRunbook.execution.env` but
 * under the cell's own `env.NAME=` options (`own`): the cell is the more specific setting.
 */
export function withDotenv(env: Record<string, string>, vars: Record<string, string>, own: Record<string, string>): Record<string, string> {
  return { ...env, ...vars, ...own };
}

/** The values of a parsed `.env` file to redact by exact match. */
export function dotenvSecrets(vars: Record<string, string>): string[] {
  return Object.entries(vars)
    .filter(([k, v]) => isRedactableValue(v) && (looksSecretKey(k) || looksLikeSecretValue(v)))
    .map(([, v]) => v);
}

/**
 * Signed runbooks: the manifest a publisher signs, and the signature block that carries it in
 * the `.md` file. A server with md-runbook-gate (apps/gate) runs only cells of a manifest signed
 * by a key it trusts; see docs/features/signed-runbooks.md.
 *
 * The manifest holds exactly what the gate runs (each bash cell's code with `${param:NAME}`
 * rewritten to `${NAME}`, its `cwd=` and `env.*`, and its commands for line runs), so the gate
 * never parses Markdown and a newer client can't change what an old signature covers. It travels
 * inside the file, base64 in an HTML comment at the end, next to the SSH signature (SSHSIG,
 * `ssh-keygen -Y sign -n md-runbook`). Clients compare the file's cells with it to show which
 * cells are signed.
 *
 * Manifest version 2 also signs the whole text: a `text` item holds the SHA-256 of the runbook as
 * reviewed (signedText: without the signature block, stored outputs, notes and ticked boxes), so
 * clients can tell "the whole runbook is as signed" (prose, front matter, checklists, PowerShell
 * blocks) from "its bash blocks are". The header line stays `md-runbook-manifest 1`: gates
 * installed before read items by key and ignore `text`, so they run v2 manifests unchanged. A
 * manifest without `text` is version 1 (signed before), and still verifies: only its blocks are
 * signed.
 */

import { callRefs, isCallLanguage, parseCall } from './call';
import { parseCellOptions } from './cellOptions';
import { FenceOpen, isFenceClose, langOf, matchFenceOpen } from './fence';
import { kubeContextParam } from './kubeContext';
import { isCodeMeta } from './model';
import { parse } from './parser';
import { VAR_NAME_RE, findRefs, frontMatterLines, parseFrontMatter, reportAddressProblem, rewriteRefs } from './secrets';
import { sha256Hex } from './sha256';
import { shellKindForLanguage } from './shellKind';
import { splitSteps } from './steps';
import { HISTORY_OPEN_RE } from './outputBlock';
import { clearOutputBlocks } from './writer';
import { LINE_RE, splitLines } from './lines';

/** The `-n` namespace of every md-runbook signature: a signature for anything else doesn't verify. */
export const SIGNATURE_NAMESPACE = 'md-runbook';

export const MANIFEST_HEADER = 'md-runbook-manifest 1';

export const RUNBOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (the gate compares dates as text: 2026-99-99 would never expire). */
const isDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** The names isReservedVar refuses as a whole (md-runbook-gate's is_reserved has the same list). */
export const RESERVED_VARS: readonly string[] = [
  // The shell.
  'PATH', 'IFS', 'ENV', 'BASH_ENV', 'CDPATH', 'GLOBIGNORE', 'HOME', 'SHELL', 'SHELLOPTS', 'BASHOPTS', 'PS1', 'PS2', 'PS3', 'PS4',
  'PROMPT_COMMAND', 'PWD', 'OLDPWD', 'TMPDIR', 'BASH_COMPAT', 'BASH_XTRACEFD', 'HISTFILE',
  // The C library and the locale.
  'LANG', 'LANGUAGE', 'GCONV_PATH', 'LOCPATH', 'GLIBC_TUNABLES',
  // Interpreters that load code from the environment.
  'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS', 'LUA_INIT', 'PERLLIB', 'PHPRC', 'OPENSSL_CONF',
  // git's commands and config.
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF',
  // Programs that other programs start.
  'SSH_ASKPASS', 'PAGER', 'LESSOPEN', 'LESSCLOSE', 'KUBECTL_EXTERNAL_DIFF', 'EDITOR', 'VISUAL', 'BROWSER',
  // Where programs connect, and which certificates they trust.
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME', 'CURL_CA_BUNDLE',
  'ftp_proxy', 'FTP_PROXY', 'HOSTALIASES', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'XDG_CONFIG_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
];
/** The prefixes isReservedVar refuses. */
export const RESERVED_VAR_PREFIXES: readonly string[] = ['LC_', 'LD_', 'DYLD_', 'BASH_FUNC_', '__mdrb_', 'MD_RUNBOOK_GATE_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];
const RESERVED = new Set(RESERVED_VARS);

/**
 * Names a parameter or env.* value may not have: they change how the shell or the programs it
 * starts read the signed code, or where they connect. md-runbook-gate refuses the same
 * (is_reserved). Not KUBECONFIG: env.KUBECONFIG picks a cluster, and is signed.
 */
export function isReservedVar(name: string): boolean {
  return RESERVED.has(name) || RESERVED_VAR_PREFIXES.some((p) => name.startsWith(p));
}

/** JavaScript-only regex syntax, which the gate's `grep -E` reads differently (or not at all). */
const NOT_POSIX_ERE = /\\[dDwWsSbB1-9]|\(\?|[*+?}]\?/;

export interface ManifestMeta {
  name: string;
  /** A positive integer; `sign` counts it up on each signing. */
  version: number;
  /** `YYYY-MM-DD` (UTC): the gate refuses the manifest after that day. */
  expires?: string;
  /** Where it may run: a server and a key must accept one of these. None: only servers that accept any scope. */
  scopes: string[];
  /** For each `${param:NAME}`: the POSIX extended regular expression its whole value must match. */
  patterns: Record<string, string>;
}

export interface ManifestCell {
  /** 1-based, in file order among the signed cells. */
  n: number;
  /** `any`: single lines and ranges may run (`lines=any`); `all`: the whole cell, or its commands in order. */
  lines: 'all' | 'any';
  /**
   * The fence's info string as written, for clients to compare. The gate reads its
   * `kube-context=` and runs the cell only while kubectl's current context is that one.
   */
  info: string;
  /** The code as the gate runs it. */
  code: string;
  /** The parameters it uses: the gate runs it only once each has a value. */
  needs: string[];
  cwd?: string;
  env: Record<string, string>;
  /** The cell's commands for line runs, as the gate runs them. */
  steps: string[];
}

/**
 * A runbook call (```runbook block, core/call.ts) as signed: its options and body as written. The
 * gate doesn't run calls; `md-runbook run --allowed-signers` checks them, and the runbooks they
 * call must be signed themselves.
 */
export interface ManifestCall {
  /** 1-based, in file order among the calls. */
  n: number;
  info: string;
  body: string;
  /** The parameters its src= and values use (each has a pattern). */
  needs: string[];
}

export interface Manifest extends ManifestMeta {
  cells: ManifestCell[];
  calls: ManifestCall[];
  /**
   * Version 2: SHA-256 (hex) of the whole runbook as signed (signedText). Absent in a version 1
   * manifest, which signs only the bash/sh blocks and runbook calls.
   */
  text?: string;
}

/** 2 when the manifest signs the whole text, 1 when only its blocks and calls. */
export const manifestVersion = (m: Pick<Manifest, 'text'>): 1 | 2 => (m.text !== undefined ? 2 : 1);

/**
 * What signedText sets aside, only in the exact form md-runbook writes it, so that none of it is
 * text a reader sees (security review, round 4). Before, a record block took any lines up to a
 * `-->` (a line `x -->` ends the comment for a Markdown view, and what follows shows), and a note
 * marker could carry HTML after its `-->`.
 *
 * - A run record's signature (record.ts): its header, then base64 lines, cosign lines, `-->`.
 *   Names and times hold no spaces and no `--`.
 * - A note's marker (incident.ts formatNote): one comment alone on its line, without `>` or `--`
 *   inside; then its quote lines.
 * - An output block's markers likewise; when one is not, no output block is set aside.
 * - An output block, and each of its history, in the form formatOutputBlock writes it
 *   (outputsAsWritten); when one is not, no output block is set aside.
 */
const FIELD = '(?:[A-Za-z0-9_@.+:]|-(?!-))+';
const B64_LINES = '(?:[A-Za-z0-9+/=]+\\n)+';
const RECORD_BLOCK_RE = new RegExp(
  `^<!-- md-runbook:record-signature v1 signer=${FIELD} signed=${FIELD} sha256=[0-9a-f]{64}\\nsignature\\n${B64_LINES}(?:cosign signer=${FIELD} signed=${FIELD}\\n${B64_LINES})*-->[ \\t]*(?:\\n|$)`,
  'gm',
);
const NOTE_BLOCK_RE = /^[ \t]*<!--[ \t]*md-runbook:note\b(?:[^>\n-]|-(?!-))*-->[ \t]*\n(?:[ \t]*>.*(?:\n|$))*/gm;
const OUTPUT_MARK_RE = /^[ \t]*<!--[ \t]*md-runbook:output (?:start|end)\b/;
const STRICT_OUTPUT_MARK_RE = /^[ \t]*<!--[ \t]*md-runbook:output (?:start|end)\b(?:[^<>\n-]|-(?!-))*-->[ \t]*$/;
/** The summary of earlier runs (history.ts historySummary), which a Markdown view shows. */
const STRICT_HISTORY_OPEN_RE = /^[ \t]*<details>[ \t]*<summary>[ \t]*md-runbook: \d+ previous runs?<\/summary>[ \t]*$/;
const TASK_BOX_RE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)[xX](\](?=[ \t]|$))/;

/**
 * Whether the output block `raw` (LF, start marker through end marker) is as formatOutputBlock
 * writes it at `indent`: each marker at the indent, the open fence `indent` + backticks + `text`,
 * the close fence exactly the same backticks at the indent, every other line empty or at the
 * indent. Before, any fence the parser took was set aside: a fence indented 4 spaces or a tab is
 * no fence on GitHub, and its "output" showed as prose (bold, headings) in a runbook still signed
 * as a whole; a close fence indented 4 spaces ended the block for the parser only, and turned the
 * signed prose after it into code there (security review, round 5).
 */
function blockAsWritten(raw: string, indent: string): boolean {
  const lines = raw.replace(/\n$/, '').split('\n');
  if (lines.length < 4) return false;
  const [start, open] = lines as [string, string];
  const close = lines[lines.length - 2]!;
  const end = lines[lines.length - 1]!;
  const fence = /^`{3,}(?=text$)/.exec(open.slice(indent.length))?.[0];
  const atIndent = (l: string): boolean => l.startsWith(indent) && !/^[ \t]/.test(l.slice(indent.length));
  return (
    fence !== undefined &&
    open === `${indent}${fence}text` &&
    close === indent + fence &&
    atIndent(start) &&
    STRICT_OUTPUT_MARK_RE.test(start) &&
    end === `${indent}<!-- md-runbook:output end -->` &&
    lines.slice(2, -2).every((l) => l === '' || l.startsWith(indent))
  );
}

/** Whether every output block of LF text `t`, and its history, is as md-runbook writes it (blockAsWritten). */
function outputsAsWritten(t: string): boolean {
  for (const c of parse(t).cells) {
    const m = c.meta;
    if (m.kind !== 'code') continue;
    if (m.output && !blockAsWritten(m.output.raw.slice(m.output.gap.length), m.indent)) return false;
    if (!m.history) continue;
    const lines = m.history.raw.slice(m.history.gap.length).replace(/\n$/, '').split('\n');
    const [first] = lines as [string];
    if (!first.startsWith(m.indent) || /^[ \t]/.test(first.slice(m.indent.length)) || lines[lines.length - 1] !== `${m.indent}</details>`) return false;
    if (!m.history.entries.every((e) => e.raw !== undefined && blockAsWritten(e.raw, m.indent))) return false;
  }
  return true;
}

/**
 * Offsets of the lines of LF text that are prose: in no code cell the parser finds, in no other
 * fenced block, and no fence line themselves. An unclosed fence makes the rest code.
 */
function proseLineOffsets(t: string): Set<number> {
  const code: [number, number][] = [];
  let at = 0;
  for (const { meta: m } of parse(t).cells) {
    const raw =
      m.kind === 'code' ? m.lead + m.open + m.body + m.close + (m.output?.raw ?? '') + (m.history?.raw ?? '') + m.trail : m.lead + m.content + m.trail;
    if (m.kind === 'code') code.push([at, at + raw.length]);
    at += raw.length;
  }
  const prose = new Set<number>();
  let open: FenceOpen | null = null;
  let offset = 0;
  for (const line of t.split('\n')) {
    if (open) {
      if (isFenceClose(line, open)) open = null;
    } else {
      open = matchFenceOpen(line);
      if (!open && !code.some(([a, b]) => offset >= a && offset < b)) prose.add(offset);
    }
    offset += line.length + 1;
  }
  return prose;
}

/** Where the front matter of LF text `t` ends (the offset after its closing line), or 0 without one. */
function frontMatterEnd(t: string): number {
  const lines = t.split('\n');
  if (lines[0]?.trimEnd() !== '---') return 0;
  let at = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) return at + lines[i]!.length;
    at += lines[i]!.length + 1;
  }
  return 0;
}

/**
 * `t` without the matches of `re` (global) whose every line is prose (proseLineOffsets). Never
 * in the front matter: a note line inside `env:` ends the list there.
 */
function removeInProse(t: string, re: RegExp): string {
  const prose = proseLineOffsets(t);
  const head = frontMatterEnd(t);
  return t.replace(re, (match: string, ...rest: unknown[]) => {
    let line = rest[rest.length - 2] as number;
    if (line < head) return match;
    for (const l of match.replace(/\n$/, '').split('\n')) {
      if (!prose.has(line)) return match;
      line += l.length + 1;
    }
    return '';
  });
}

/**
 * The text a version 2 signature covers: line endings as LF, no BOM, and without what running the
 * runbook adds: its signature block, a run record's signature, stored outputs (with their
 * history), notes (Add Note) and ticks in checklists, each only outside code blocks (inside one,
 * the same lines are code and signed). Trailing blank lines don't count.
 *
 * What is set aside never changes the front matter: when it would (a note or the signature block
 * above the `---`, which then becomes front matter), the result starts with a CR, which no other
 * signedText has, so it matches no signature. Before, a note line above the front matter, or
 * inside it, left a whole-runbook signature valid while every client read the front matter
 * differently, or not at all (security review, round 4).
 */
export function signedText(text: string): string {
  const lf = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let t = withoutSignature(text.replace(/^\uFEFF/, '')).replace(/\r\n?/g, '\n');
  // A run record's signature and notes only outside code: a note-shaped line in a block is code.
  t = removeInProse(t, RECORD_BLOCK_RE);
  const written = (l: string): boolean => (!OUTPUT_MARK_RE.test(l) || STRICT_OUTPUT_MARK_RE.test(l)) && (!HISTORY_OPEN_RE.test(l) || STRICT_HISTORY_OPEN_RE.test(l));
  if (t.split('\n').every(written) && outputsAsWritten(t)) t = clearOutputBlocks(t);
  t = removeInProse(t, NOTE_BLOCK_RE);
  // Ticks, outside code blocks.
  let open: FenceOpen | null = null;
  t = t
    .split('\n')
    .map((line) => {
      if (open) {
        if (isFenceClose(line, open)) open = null;
        return line;
      }
      const f = matchFenceOpen(line);
      if (f) {
        open = f;
        return line;
      }
      return line.replace(TASK_BOX_RE, '$1 $2');
    })
    .join('\n');
  const before = frontMatterLines(lf);
  const after = frontMatterLines(t);
  const same = before === undefined ? after === undefined : after !== undefined && before.length === after.length && before.every((l, i) => l === after[i]);
  return (same ? '' : '\r') + t.replace(/\s+$/, '') + '\n';
}

/** SHA-256 (hex) of signedText: the `text` item of a version 2 manifest. */
export const signedTextHash = (text: string): string => sha256Hex(signedText(text));

// ---- base64 of UTF-8 text, without Buffer (the app's runtimes have none) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : B64[c & 63]!;
  }
  return out;
}

/** undefined when `b64` is not canonical padded base64 of UTF-8 text. */
export function fromBase64(b64: string): string | undefined {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return undefined;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((b64.length / 4) * 3 - pad);
  let k = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const v = [0, 1, 2, 3].map((j) => (b64[i + j] === '=' ? 0 : B64.indexOf(b64[i + j]!)));
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    for (const byte of [n >> 16, (n >> 8) & 255, n & 255]) if (k < bytes.length) bytes[k++] = byte;
  }
  // Not valid UTF-8 when it doesn't encode back to the same bytes (the app's engines may lack `fatal`).
  const text = new TextDecoder().decode(bytes);
  return toBase64(text) === b64 ? text : undefined;
}

// ---- the manifest ----

/** The cells a manifest covers: every bash/sh code cell (the gate's shell), in file order. */
/** The runbook calls of a runbook (```runbook blocks), with their cell index. */
function callCells(text: string): { index: number; info: string; value: string }[] {
  const out: { index: number; info: string; value: string }[] = [];
  parse(text).cells.forEach((cell, index) => {
    if (cell.kind === 'code' && isCodeMeta(cell.meta) && isCallLanguage(cell.languageId)) out.push({ index, info: cell.meta.info.trim(), value: cell.value });
  });
  return out;
}

function bashCells(text: string): { index: number; info: string; value: string }[] {
  const out: { index: number; info: string; value: string }[] = [];
  parse(text).cells.forEach((cell, index) => {
    if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return;
    if (shellKindForLanguage(cell.languageId) !== 'bash') return;
    out.push({ index, info: cell.meta.info.trim(), value: cell.value });
  });
  return out;
}

/** CommonMark's HTML block tags of type 6 (they end at a blank line). */
const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

/**
 * Where an HTML block of CommonMark types 1 and 3–6 that starts on `line` ends: a test for the line
 * that ends it (type 6: a blank line). Undefined when no such block starts there, or it ends on the
 * same line. Comments (type 2) are tracked on their own, more widely.
 */
function htmlBlockEnd(line: string): ((l: string) => boolean) | undefined {
  const starts: [RegExp, RegExp][] = [
    [/^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(script|pre|style|textarea)>/i],
    [/^ {0,3}<\?/, /\?>/],
    [/^ {0,3}<![A-Za-z]/, />/],
    [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  ];
  for (const [start, end] of starts) {
    const m = start.exec(line);
    if (m) return end.test(line.slice(m[0].length)) ? undefined : (l) => end.test(l);
  }
  if (new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?=[\\s/>]|$)`, 'i').test(line)) return (l) => l.trim() === '';
  return undefined;
}

/**
 * Fences a reviewer reading the rendered file (a pull request on GitHub) would not see as code
 * that runs: a bash block inside an HTML comment or another HTML block (`<script>`, `<pre>`,
 * `<textarea>`, `<style>`, `<?…?>`, `<!X …>`, `<![CDATA[`, `<div>` up to a blank line), and fences
 * indented 4 spaces or more (CommonMark reads those as an indented code block, or doesn't close a
 * block there). The parser accepts them all. Lines end as CommonMark reads them (a lone CR too).
 */
function hiddenFences(text: string): string[] {
  const problems: string[] = [];
  let open: FenceOpen | null = null;
  let inComment = false;
  /** In an HTML block (not a comment): the test of the line that ends it. */
  let html: ((l: string) => boolean) | undefined;
  text.split(LINE_RE).forEach((line, i) => {
    // CommonMark sees no fence in an HTML block: its end counts on every line, fenced or not.
    const inHtml = html !== undefined;
    if (html?.(line)) html = undefined;
    if (open) {
      if (isFenceClose(line, open)) {
        if (/^( {4}|\t| {0,3}\t)/.test(line)) problems.push(`line ${i + 1}: a closing fence indented 4 spaces or more (indent fences less, so GitHub shows the same blocks)`);
        open = null;
      }
      return;
    }
    const f = matchFenceOpen(line);
    if (f) {
      if (/^( {4}|\t| {0,3}\t)/.test(f.indent)) problems.push(`line ${i + 1}: a fence indented 4 spaces or more (indent fences less, so GitHub shows the same blocks)`);
      const bash = shellKindForLanguage(langOf(f.info)) === 'bash';
      if (inComment && bash) problems.push(`line ${i + 1}: a bash block inside an HTML comment (<!-- … -->) is hidden on GitHub but would be signed`);
      else if (inHtml && bash) problems.push(`line ${i + 1}: a bash block inside an HTML block (<script>, <pre>, <div>, …) is not shown as code on GitHub but would be signed`);
      open = f;
      return;
    }
    // Comment state from the prose between fences: the last <!-- or --> on the line wins.
    for (const m of line.matchAll(/<!--|-->/g)) inComment = m[0] === '<!--';
    if (!inHtml && !inComment) html = htmlBlockEnd(line);
  });
  return problems;
}

/**
 * The manifest of a runbook, or the reasons it can't be signed (each names the cell). Version 2
 * (the whole text signed) unless `version: 1` (co-signing a manifest signed before).
 */
export function buildManifest(text: string, meta: ManifestMeta, opts: { version?: 1 | 2 } = {}): { manifest: Manifest } | { errors: string[] } {
  const errors: string[] = [];
  if (!RUNBOOK_NAME_RE.test(meta.name)) errors.push(`name "${meta.name}": use letters, digits and . _ / - (at most 100)`);
  if (!Number.isInteger(meta.version) || meta.version < 1) errors.push(`version ${meta.version}: expected a positive whole number`);
  if (meta.expires !== undefined && !isDate(meta.expires)) errors.push(`expires ${meta.expires}: expected a date, YYYY-MM-DD`);
  for (const s of meta.scopes) if (!SCOPE_RE.test(s)) errors.push(`scope "${s}": use letters, digits and . _ - (at most 64)`);
  for (const [name, re] of Object.entries(meta.patterns)) {
    if (!VAR_NAME_RE.test(name)) errors.push(`pattern for "${name}": not a parameter name`);
    else if (isReservedVar(name)) errors.push(`\${param:${name}}: ${name} can't be a parameter of a signed runbook (it changes how the shell runs the code)`);
    if (re === '' || /[\r\n]/.test(re)) errors.push(`pattern for ${name}: empty or more than one line`);
    else if (NOT_POSIX_ERE.test(re)) {
      errors.push(`pattern for ${name}: ${re} uses JavaScript-only syntax (\\d, \\w, (?…), lazy *?, back-references); servers check it with grep -E: use [0-9], [A-Za-z0-9_], …`);
    }
  }
  errors.push(...hiddenFences(withoutSignature(text)));
  // Servers run signed cells in bash (md-runbook-gate), and the front matter isn't signed.
  const unix = parseFrontMatter(text)?.shell?.unix;
  if (unix && unix !== 'bash') errors.push(`front matter shell: ${unix}: servers run signed runbooks in bash; remove it, or write shell: bash`);
  // A signature can make reporting required (runReport.ts): its settings must read as written.
  errors.push(...reportSigningErrors(text));
  // capture-secret= values reach the gate as parameters too, and the gate logs every parameter
  // value: a signed cell can't use them.
  const secretCaptures = new Set<string>();
  for (const c of bashCells(text)) for (const cap of parseCellOptions(c.info).checks?.captures ?? []) if (cap.secret) secretCaptures.add(cap.name);
  const cells: ManifestCell[] = [];
  /** kube-context=${param:NAME} parameters: their patterns are signed, so the gate can check the value. */
  const contextParams: string[] = [];
  for (const c of bashCells(text)) {
    const n = cells.length + 1;
    const where = `cell ${n} (${c.value.split('\n')[0]?.slice(0, 40) ?? ''})`;
    const opts = parseCellOptions(c.info);
    for (const e of opts.errors) errors.push(`${where}: invalid option ${e}`);
    const needs: string[] = [];
    try {
      // ${param:}, ${input:} and ${out:} values go to the gate, which checks them against the
      // signed pattern and logs them; secrets don't (the log would hold them).
      for (const ref of findRefs(c.value)) {
        const token = `\${${ref.kind}:${ref.name}${ref.kind === 'input' && ref.secret ? ':secret' : ''}}`;
        if (ref.kind === 'secret') errors.push(`${where}: ${token} can't be signed (servers log the values signed cells get)`);
        else if (ref.secret) errors.push(`${where}: ${token} can't be signed: a secret input would be in the servers' logs`);
        else if (ref.kind === 'out' && secretCaptures.has(ref.name)) errors.push(`${where}: ${token} comes from capture-secret= and can't be signed (servers log the values)`);
        else if (meta.patterns[ref.name] === undefined) errors.push(`${where}: ${token} needs a pattern (--pattern ${ref.name}=REGEX)`);
        else if (!needs.includes(ref.name)) needs.push(ref.name);
      }
    } catch (e) {
      errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // `${param:X:secret}` and the like aren't references: bash would read them as ${param:offset:length}.
    for (const m of c.value.matchAll(/\$\{(secret|input|param|out):[^}\s]*/g)) {
      // (${input:NAME:secret} is a reference: refused above as a secret.)
      if (!/^\$\{((secret|param|out):[A-Za-z_][A-Za-z0-9_]*|input:[A-Za-z_][A-Za-z0-9_]*(:secret)?)$/.test(m[0])) errors.push(`${where}: ${m[0]}} is not a plain \${${m[1]}:NAME} and can't be signed`);
    }
    // kube-context=${param:NAME} is signed in the info string: the value must match a signed pattern,
    // so a signed runbook can't be pointed at a cluster its signer did not allow.
    const contextParam = kubeContextParam(opts.kubeContext);
    if (contextParam !== undefined && meta.patterns[contextParam] === undefined) {
      errors.push(`${where}: kube-context=\${param:${contextParam}} needs a pattern (--pattern ${contextParam}=REGEX)`);
    } else if (contextParam !== undefined) contextParams.push(contextParam);
    for (const [k, v] of Object.entries(opts.env)) {
      if (!VAR_NAME_RE.test(k)) errors.push(`${where}: env.${k} is not a variable name`);
      else if (isReservedVar(k)) errors.push(`${where}: env.${k} can't be set by a signed runbook (it changes how the shell runs the code)`);
      if (/\$\{(secret|input|param|out):/.test(v)) errors.push(`${where}: env.${k} can't use placeholders in a signed runbook`);
    }
    cells.push({
      n,
      lines: opts.lines === 'any' ? 'any' : 'all',
      info: c.info,
      code: rewriteRefs(c.value, 'bash'),
      needs,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env,
      steps: splitSteps(c.value, 'bash').map((s) => rewriteRefs(s.text, 'bash')),
    });
  }
  // Runbook calls: signed as written; what they call is signed on its own.
  const calls: ManifestCall[] = [];
  for (const c of callCells(text)) {
    const n = calls.length + 1;
    const where = `runbook call ${n} (src=${parseCall(c.info, c.value).src ?? '?'})`;
    const call = parseCall(c.info, c.value);
    for (const p of call.problems) errors.push(`${where}: ${p.message}`);
    for (const e of parseCellOptions(c.info).errors) errors.push(`${where}: invalid option ${e}`);
    if (call.src !== undefined && /^([A-Za-z]:)?[\\/]/.test(call.src)) errors.push(`${where}: src= must be relative: a signed runbook calls runbooks in its own repository`);
    const needs: string[] = [];
    try {
      for (const ref of callRefs(call)) {
        const token = `\${${ref.kind}:${ref.name}}`;
        if (ref.kind === 'secret' || ref.secret) errors.push(`${where}: ${token} can't be signed: pass secrets to the runbook called another way`);
        else if (meta.patterns[ref.name] === undefined) errors.push(`${where}: ${token} needs a pattern (--pattern ${ref.name}=REGEX)`);
        else if (!needs.includes(ref.name)) needs.push(ref.name);
      }
    } catch (e) {
      errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    calls.push({ n, info: c.info, body: c.value, needs });
  }
  if (cells.length === 0 && calls.length === 0) errors.push('no bash or sh cells to sign');
  if (errors.length > 0) return { errors };
  // Only the patterns the cells, their kube-context= and the calls use. Before, a kube-context
  // parameter's pattern was left out, so the gate couldn't take its value (security review, 2026-11-16).
  const used = new Set([...cells.flatMap((c) => c.needs), ...contextParams, ...calls.flatMap((c) => c.needs)]);
  const patterns = Object.fromEntries(Object.entries(meta.patterns).filter(([k]) => used.has(k)));
  const whole = opts.version === 1 ? {} : { text: signedTextHash(text) };
  return { manifest: { ...meta, scopes: [...new Set(meta.scopes)], patterns, cells, calls, ...whole } };
}

/** Run report lines of the front matter (runReport.ts) that can't be signed as written. */
export function reportSigningErrors(text: string): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let wants = false;
  for (const line of frontMatterLines(text) ?? []) {
    const m = /^(report-runs(?:-required|-signed|-token)?)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
    if (seen.has(key)) errors.push(`front matter ${key}: written twice (keep one)`);
    seen.add(key);
    if (key === 'report-runs') {
      const why = reportAddressProblem(value);
      if (why) errors.push(`front matter report-runs: ${why}`);
    } else if (key === 'report-runs-token') {
      if (!/^\$\{secret:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) errors.push('front matter report-runs-token: only ${secret:NAME}, never a token in the file');
    } else {
      if (!/^(true|false|yes|no|on|off)$/i.test(value)) errors.push(`front matter ${key}: expected true or false`);
      if (/^(true|yes|on)$/i.test(value)) wants = true;
    }
  }
  if (!seen.has('report-runs') && (wants || seen.has('report-runs-token'))) errors.push('front matter report-runs-required, -signed or -token without report-runs: (the address)');
  return errors;
}

/** The manifest as signed: one item per line, values that could hold anything in base64. */
export function formatManifest(m: Manifest): string {
  const lines = [MANIFEST_HEADER, `name ${m.name}`, `version ${m.version}`];
  if (m.expires) lines.push(`expires ${m.expires}`);
  if (m.scopes.length > 0) lines.push(`scope ${m.scopes.join(' ')}`);
  // Version 2. A key of its own: md-runbook-gate reads items by key and doesn't use it.
  if (m.text !== undefined) lines.push(`text ${m.text}`);
  for (const [name, re] of Object.entries(m.patterns)) lines.push(`param ${name} ${toBase64(re)}`);
  for (const c of m.cells) {
    lines.push(`cell ${c.n} ${c.lines}`, `info ${toBase64(c.info)}`, `code ${toBase64(c.code)}`);
    for (const p of c.needs) lines.push(`needs ${p}`);
    if (c.cwd !== undefined) lines.push(`cwd ${toBase64(c.cwd)}`);
    for (const [k, v] of Object.entries(c.env)) lines.push(`env ${k} ${toBase64(v)}`);
    for (const s of c.steps) lines.push(`step ${toBase64(s)}`);
  }
  // Keys of their own: the gate reads its items by key, so these never mix with a cell's.
  for (const c of m.calls) {
    lines.push(`call ${c.n}`, `callinfo ${toBase64(c.info)}`, `callbody ${toBase64(c.body)}`);
    for (const p of c.needs) lines.push(`callneeds ${p}`);
  }
  lines.push('end');
  return lines.join('\n') + '\n';
}

/** Read a manifest back (clients use it to match cells); throws on anything malformed. */
export function parseManifest(text: string): Manifest {
  const lines = text.split('\n');
  if (lines[0] !== MANIFEST_HEADER) throw new Error('not an md-runbook manifest (or a newer version)');
  const m: Manifest = { name: '', version: 0, scopes: [], patterns: {}, cells: [], calls: [] };
  let cell: ManifestCell | undefined;
  let call: ManifestCall | undefined;
  const needCall = (what: string): ManifestCall => {
    if (!call) throw new Error(`manifest: ${what} outside a call`);
    return call;
  };
  const b64 = (v: string | undefined, what: string): string => {
    const s = v === undefined ? undefined : fromBase64(v);
    if (s === undefined) throw new Error(`manifest: bad ${what}`);
    return s;
  };
  const need = (what: string): ManifestCell => {
    if (!cell) throw new Error(`manifest: ${what} outside a cell`);
    return cell;
  };
  let ended = false;
  const once = new Set<string>();
  for (const line of lines.slice(1)) {
    if (ended) {
      if (line !== '') throw new Error('manifest: text after end');
      continue;
    }
    if (line === '') continue;
    const [key, a, b, ...more] = line.split(' ');
    if (more.length > 0 && key !== 'scope') throw new Error(`manifest: bad line "${line.slice(0, 40)}"`);
    // Once each: md-runbook-gate reads the first of these, so a second would mean two things.
    if (key === 'name' || key === 'version' || key === 'expires' || key === 'scope') {
      if (once.has(key)) throw new Error(`manifest: more than one ${key} line`);
      once.add(key);
    }
    switch (key) {
      case 'name':
        m.name = a ?? '';
        break;
      case 'version':
        // A whole number as md-runbook-gate reads it (is_num): no 0x10, 1e3, 007.
        if (!a || !/^[1-9][0-9]{0,5}$/.test(a)) throw new Error('manifest: bad version (expected a whole number)');
        m.version = Number(a);
        break;
      case 'expires':
        if (!a || !isDate(a)) throw new Error('manifest: bad expires (expected YYYY-MM-DD)');
        m.expires = a;
        break;
      case 'scope':
        m.scopes = line.split(' ').slice(1);
        break;
      case 'text':
        if (!a || !/^[0-9a-f]{64}$/.test(a) || b !== undefined || m.text !== undefined) throw new Error('manifest: bad text');
        m.text = a;
        break;
      case 'param':
        m.patterns[a ?? ''] = b64(b, 'pattern');
        break;
      case 'cell':
        cell = { n: Number(a), lines: b === 'any' ? 'any' : 'all', info: '', code: '', needs: [], env: {}, steps: [] };
        m.cells.push(cell);
        break;
      case 'info':
        need('info').info = b64(a, 'info');
        break;
      case 'code':
        need('code').code = b64(a, 'code');
        break;
      case 'needs':
        need('needs').needs.push(a ?? '');
        break;
      case 'cwd':
        need('cwd').cwd = b64(a, 'cwd');
        break;
      case 'env':
        need('env').env[a ?? ''] = b64(b, 'env');
        break;
      case 'step':
        need('step').steps.push(b64(a, 'step'));
        break;
      case 'call':
        call = { n: Number(a), info: '', body: '', needs: [] };
        m.calls.push(call);
        break;
      case 'callinfo':
        needCall('callinfo').info = b64(a, 'callinfo');
        break;
      case 'callbody':
        needCall('callbody').body = b64(a, 'callbody');
        break;
      case 'callneeds':
        needCall('callneeds').needs.push(a ?? '');
        break;
      case 'end':
        ended = true;
        break;
      default:
        throw new Error(`manifest: unknown item "${key}"`);
    }
  }
  if (!ended) throw new Error('manifest: no end');
  if (!RUNBOOK_NAME_RE.test(m.name) || !Number.isInteger(m.version) || m.version < 1) throw new Error('manifest: bad name or version');
  return m;
}

// ---- the signature block in the file ----

export interface SignatureBlock {
  /** Who signed, as the signer wrote it (the gate checks the key, not this name). */
  signer: string;
  /** `YYYY-MM-DD`. */
  signed: string;
  /** The manifest text, exactly as signed. */
  manifest: string;
  /** The SSHSIG blob, base64 (the armored signature without its BEGIN/END lines). */
  signature: string;
  /**
   * More signatures of the same manifest (a reviewer's, made with `sign --cosign`); a server can
   * ask for several signers (`signers = 2` in gate.conf). Names and dates are what the file says.
   */
  cosigners?: Cosigner[];
}

export interface Cosigner {
  signer: string;
  signed: string;
  signature: string;
}

const BLOCK_RE =
  /^<!-- md-runbook:signature v1 signer=(\S+) signed=(\d{4}-\d{2}-\d{2})\r?\nmanifest\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\nsignature\r?\n([A-Za-z0-9+/=\r\n]+?)((?:\r?\ncosign signer=\S+ signed=\d{4}-\d{2}-\d{2}\r?\n[A-Za-z0-9+/=\r\n]+?)*)\r?\n-->[ \t]*$/m;
const COSIGN_RE = /cosign signer=(\S+) signed=(\d{4}-\d{2}-\d{2})\r?\n([A-Za-z0-9+/=\r\n]+?)(?=\r?\ncosign |$)/g;

const wrap = (b64: string): string => b64.replace(/.{1,76}/g, '$&\n').trimEnd();

/** A signer name as the block can hold it: one word, nothing that would end the HTML comment (`--`, `>`). */
export const signerLabel = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9_@.+-]+/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 100) || 'unknown';

/**
 * A signer name that is the same in the signature block and as a principal in a server's
 * allowed_signers: ASCII letters, digits and `@ . _ + -` (no spaces, quotes, commas or patterns
 * such as `*`, which allowed_signers would read differently).
 */
export const SIGNER_NAME_RE = /^[A-Za-z0-9_@.+](?:[A-Za-z0-9_@.+]|-(?!-)){0,99}$/;

export function formatSignatureBlock(b: SignatureBlock): string {
  return (
    `<!-- md-runbook:signature v1 signer=${signerLabel(b.signer)} signed=${b.signed}\n` +
    `manifest\n${wrap(toBase64(b.manifest))}\nsignature\n${wrap(b.signature)}\n` +
    (b.cosigners ?? []).map((c) => `cosign signer=${signerLabel(c.signer)} signed=${c.signed}\n${wrap(c.signature)}\n`).join('') +
    '-->'
  );
}

/**
 * The signature block: the last one outside code blocks (it goes at the end; prose added after
 * signing doesn't hide it). A block-shaped example inside a code block is not the signature.
 */
function findBlock(text: string): RegExpExecArray | undefined {
  // Offsets of the lines that are inside fenced code.
  const inCode = new Set<number>();
  let open: FenceOpen | null = null;
  let offset = 0;
  for (const { text: bare, eol } of splitLines(text)) {
    if (open) {
      inCode.add(offset);
      if (isFenceClose(bare, open)) open = null;
    } else open = matchFenceOpen(bare);
    offset += bare.length + eol.length;
  }
  const re = new RegExp(BLOCK_RE.source, 'gm');
  let last: RegExpExecArray | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) if (!inCode.has(m.index)) last = m;
  return last;
}

/** The file's signature block, or undefined when it has none (or a malformed one). */
export function readSignature(text: string): SignatureBlock | undefined {
  const m = findBlock(text);
  if (!m) return undefined;
  // A name allowed_signers would read differently (a pattern, a list) is no signer's name.
  if (!SIGNER_NAME_RE.test(m[1]!)) return undefined;
  const manifest = fromBase64(m[3]!.replace(/\s+/g, ''));
  if (manifest === undefined) return undefined;
  const cosigners = [...(m[5] ?? '').trim().matchAll(COSIGN_RE)].map((c) => ({ signer: c[1]!, signed: c[2]!, signature: c[3]!.replace(/\s+/g, '') }));
  if (cosigners.some((c) => !SIGNER_NAME_RE.test(c.signer))) return undefined;
  return { signer: m[1]!, signed: m[2]!, manifest, signature: m[4]!.replace(/\s+/g, ''), ...(cosigners.length ? { cosigners } : {}) };
}

/**
 * Whether `text` still makes exactly the manifest `block` signed, so a second signer (a
 * reviewer) can sign that manifest as it is: co-signing never changes what was signed.
 */
export function cosignable(text: string, block: SignatureBlock): boolean {
  let m: Manifest;
  try {
    m = parseManifest(block.manifest);
  } catch {
    return false;
  }
  // A version 1 manifest is co-signed as version 1 (co-signing never changes what was signed).
  const built = buildManifest(text, { name: m.name, version: m.version, ...(m.expires ? { expires: m.expires } : {}), scopes: m.scopes, patterns: m.patterns }, { version: manifestVersion(m) });
  return !('errors' in built) && formatManifest(built.manifest) === block.manifest;
}

/** Every signature of a block, the first signer's first (what a gate gets with the manifest). */
export function allSignatures(b: SignatureBlock): string[] {
  return [b.signature, ...(b.cosigners ?? []).map((c) => c.signature)];
}

/** The signers' names as the file gives them (only a gate's check proves who signed). */
export function signerNames(b: SignatureBlock): string[] {
  return [b.signer, ...(b.cosigners ?? []).map((c) => c.signer)];
}

/** The text without its signature block (and the blank line before it). */
export function withoutSignature(text: string): string {
  const m = findBlock(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/(\r?\n)[ \t]*(\r?\n)+$/, '$1');
  return before + text.slice(m.index + m[0].length).replace(/^\r?\n/, '');
}

/** The text with `block` as its signature: in place of an earlier one, else at the end. */
export function withSignature(text: string, block: SignatureBlock): string {
  const base = withoutSignature(text);
  const eol = /\r\n/.test(base) ? '\r\n' : '\n';
  const formatted = formatSignatureBlock(block).replace(/\n/g, eol);
  const body = base.replace(/(\r?\n)*$/, '');
  return (body === '' ? '' : body + eol + eol) + formatted + eol;
}

/** `-----BEGIN SSH SIGNATURE-----` armor around a base64 SSHSIG blob, as ssh-keygen reads it. */
export function armorSignature(b64: string): string {
  return `-----BEGIN SSH SIGNATURE-----\n${wrap(b64)}\n-----END SSH SIGNATURE-----\n`;
}

/** The base64 blob of an armored signature (what the file keeps). */
export function unarmorSignature(armored: string): string {
  const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored);
  if (!m) throw new Error('not an SSH signature');
  return m[1]!.replace(/\s+/g, '');
}

// ---- which cells of a file are signed ----

export interface SignedCell {
  /** The cell's number in the manifest (what the gate is asked to run). */
  n: number;
  lines: 'all' | 'any';
  /** The cell's commands as signed (line runs are matched against these). */
  steps: readonly string[];
  /** Parameters the gate needs a value of before it runs the cell. */
  needs: readonly string[];
}

export interface SignedStatus {
  block: SignatureBlock;
  manifest: Manifest;
  /** Signed cells of the file by cell index: unchanged since signing. */
  cells: Map<number, SignedCell>;
  /** Indexes of bash/sh cells that are not in the manifest (new, or changed since signing). */
  changed: number[];
  /** Manifest numbers of signed cells no longer in the file (deleted, or changed: see `changed`). */
  missing: number[];
  /** Indexes of signed cells now before a cell that was signed ahead of them (blocks reordered). */
  moved: number[];
  /** Runbook calls of the file by cell index: unchanged since signing (new or changed ones are in `changed`). */
  calls: Map<number, ManifestCall>;
  /** Manifest numbers of signed calls no longer in the file as signed. */
  missingCalls: number[];
  /**
   * 2: the signature covers the whole runbook (prose, front matter, every block); 1: only its
   * bash/sh blocks and runbook calls ("partly signed": signed before manifest version 2).
   */
  version: 1 | 2;
  /** Version 2 only: the text changed since signing (outside outputs, notes and ticks). Always false for version 1. */
  textChanged: boolean;
  /**
   * Indexes of runnable cells a version 1 signature doesn't cover and never could (PowerShell,
   * cmd): in a "partly signed" runbook they are not signed. Version 2: in `changed` when added.
   */
  unsigned: number[];
}

/** The text and every block are as signed (version 2), nothing moved or missing. */
export const wholeRunbookSigned = (s: SignedStatus): boolean =>
  s.version === 2 && !s.textChanged && s.changed.length === 0 && s.missing.length === 0 && s.moved.length === 0 && s.missingCalls.length === 0 && s.unsigned.length === 0;

/**
 * Compare the file's cells with its signed manifest. A cell is signed when its info string and
 * code match a manifest cell (moving cells keeps them signed); undefined when the file has no
 * readable signature block.
 */
export function signedStatus(text: string): SignedStatus | undefined {
  const block = readSignature(text);
  if (!block) return undefined;
  let manifest: Manifest;
  try {
    manifest = parseManifest(block.manifest);
  } catch {
    return undefined;
  }
  const free = [...manifest.cells];
  const cells = new Map<number, SignedCell>();
  const changed: number[] = [];
  const moved: number[] = [];
  let highest = 0;
  for (const c of bashCells(text)) {
    const code = rewriteRefs(c.value, 'bash');
    // The same code with other placeholders (${X} made ${input:X}) is not the cell signed.
    let names: string[] | undefined;
    try {
      names = findRefs(c.value).map((r) => r.name);
    } catch {
      names = undefined;
    }
    const sameNeeds = (m: ManifestCell): boolean => !!names && names.length === m.needs.length && names.every((n) => m.needs.includes(n));
    const k = free.findIndex((m) => m.info === c.info && m.code === code && sameNeeds(m));
    if (k < 0) {
      changed.push(c.index);
      continue;
    }
    const m = free.splice(k, 1)[0]!;
    cells.set(c.index, { n: m.n, lines: m.lines, steps: m.steps, needs: m.needs });
    // The shell carries cd, variables and set -e from block to block: the signed order matters.
    if (m.n < highest) moved.push(c.index);
    highest = Math.max(highest, m.n);
  }
  const freeCalls = [...manifest.calls];
  const calls = new Map<number, ManifestCall>();
  for (const c of callCells(text)) {
    const k = freeCalls.findIndex((m) => m.info === c.info && m.body === c.value);
    if (k < 0) changed.push(c.index);
    else calls.set(c.index, freeCalls.splice(k, 1)[0]!);
  }
  // Other runnable blocks (PowerShell, cmd): never in a manifest. With the whole text signed
  // (version 2) adding one changes the text; a version 1 signature never covered them.
  const version = manifestVersion(manifest);
  // And the front matter as read must be the one signed (signedText keeps it, but this is what
  // every client acts on: env:, kube-context:, report-runs:, params:).
  const textChanged =
    version === 2 && (signedTextHash(text) !== manifest.text || JSON.stringify(parseFrontMatter(text) ?? null) !== JSON.stringify(parseFrontMatter(signedText(text)) ?? null));
  const unsigned: number[] = [];
  parse(text).cells.forEach((cell, index) => {
    if (cell.kind !== 'code' || !isCodeMeta(cell.meta) || isCallLanguage(cell.languageId)) return;
    const kind = shellKindForLanguage(cell.languageId);
    if (kind && kind !== 'bash') unsigned.push(index);
  });
  return {
    block,
    manifest,
    cells,
    changed: changed.sort((a, b) => a - b),
    missing: free.map((m) => m.n),
    moved,
    calls,
    missingCalls: freeCalls.map((m) => m.n),
    version,
    textChanged,
    unsigned: version === 2 && !textChanged ? [] : unsigned,
  };
}

/**
 * The signed step a line-run command maps to (by its text as the gate runs it), or -1. `at`, the
 * command's position in the cell, decides between commands that repeat (two `sleep 5`).
 */
export function signedStepIndex(cell: SignedCell, stepText: string, at?: number): number {
  const text = rewriteRefs(stepText, 'bash');
  if (at !== undefined && cell.steps[at] === text) return at;
  return cell.steps.indexOf(text);
}

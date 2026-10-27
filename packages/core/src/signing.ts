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
 */

import { parseCellOptions } from './cellOptions';
import { FenceOpen, isFenceClose, langOf, matchFenceOpen } from './fence';
import { isCodeMeta } from './model';
import { parse } from './parser';
import { VAR_NAME_RE, findRefs, parseFrontMatter, rewriteRefs } from './secrets';
import { shellKindForLanguage } from './shellKind';
import { splitSteps } from './steps';

/** The `-n` namespace of every md-runbook signature: a signature for anything else doesn't verify. */
export const SIGNATURE_NAMESPACE = 'md-runbook';

export const MANIFEST_HEADER = 'md-runbook-manifest 1';

export const RUNBOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (the gate compares dates as text: 2026-99-99 would never expire). */
const isDate = (s: string): boolean => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Names a parameter or env.* value may not have: they change how the shell or the programs it
 * starts read the signed code. md-runbook-gate refuses the same (is_reserved).
 */
export function isReservedVar(name: string): boolean {
  return (
    /^(PATH|IFS|ENV|BASH_ENV|CDPATH|GLOBIGNORE|HOME|SHELL|SHELLOPTS|BASHOPTS|PS[1-4]|PROMPT_COMMAND|PWD|OLDPWD|TMPDIR|LANG|LANGUAGE)$/.test(name) ||
    /^(LC_|LD_|DYLD_|BASH_FUNC_|__mdrb_|MD_RUNBOOK_GATE_)/.test(name)
  );
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
  /** The fence's info string as written, for clients to compare (the gate doesn't read it). */
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

export interface Manifest extends ManifestMeta {
  cells: ManifestCell[];
}

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
function bashCells(text: string): { index: number; info: string; value: string }[] {
  const out: { index: number; info: string; value: string }[] = [];
  parse(text).cells.forEach((cell, index) => {
    if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return;
    if (shellKindForLanguage(cell.languageId) !== 'bash') return;
    out.push({ index, info: cell.meta.info.trim(), value: cell.value });
  });
  return out;
}

/**
 * Fences a reviewer reading the rendered file (a pull request on GitHub) would not see as code
 * that runs: a bash block inside an HTML comment, and fences indented 4 spaces or more (CommonMark
 * reads those as an indented code block, or doesn't close a block there). The parser accepts both.
 */
function hiddenFences(text: string): string[] {
  const problems: string[] = [];
  let open: FenceOpen | null = null;
  let inComment = false;
  text.split(/\r?\n/).forEach((line, i) => {
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
      if (inComment && shellKindForLanguage(langOf(f.info)) === 'bash') problems.push(`line ${i + 1}: a bash block inside an HTML comment (<!-- … -->) is hidden on GitHub but would be signed`);
      open = f;
      return;
    }
    // Comment state from the prose between fences: the last <!-- or --> on the line wins.
    for (const m of line.matchAll(/<!--|-->/g)) inComment = m[0] === '<!--';
  });
  return problems;
}

/** The manifest of a runbook, or the reasons it can't be signed (each names the cell). */
export function buildManifest(text: string, meta: ManifestMeta): { manifest: Manifest } | { errors: string[] } {
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
  // capture-secret= values reach the gate as parameters too, and the gate logs every parameter
  // value: a signed cell can't use them.
  const secretCaptures = new Set<string>();
  for (const c of bashCells(text)) for (const cap of parseCellOptions(c.info).checks?.captures ?? []) if (cap.secret) secretCaptures.add(cap.name);
  const cells: ManifestCell[] = [];
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
  if (cells.length === 0) errors.push('no bash or sh cells to sign');
  if (errors.length > 0) return { errors };
  // Only the patterns the cells use.
  const used = new Set(cells.flatMap((c) => c.needs));
  const patterns = Object.fromEntries(Object.entries(meta.patterns).filter(([k]) => used.has(k)));
  return { manifest: { ...meta, scopes: [...new Set(meta.scopes)], patterns, cells } };
}

/** The manifest as signed: one item per line, values that could hold anything in base64. */
export function formatManifest(m: Manifest): string {
  const lines = [MANIFEST_HEADER, `name ${m.name}`, `version ${m.version}`];
  if (m.expires) lines.push(`expires ${m.expires}`);
  if (m.scopes.length > 0) lines.push(`scope ${m.scopes.join(' ')}`);
  for (const [name, re] of Object.entries(m.patterns)) lines.push(`param ${name} ${toBase64(re)}`);
  for (const c of m.cells) {
    lines.push(`cell ${c.n} ${c.lines}`, `info ${toBase64(c.info)}`, `code ${toBase64(c.code)}`);
    for (const p of c.needs) lines.push(`needs ${p}`);
    if (c.cwd !== undefined) lines.push(`cwd ${toBase64(c.cwd)}`);
    for (const [k, v] of Object.entries(c.env)) lines.push(`env ${k} ${toBase64(v)}`);
    for (const s of c.steps) lines.push(`step ${toBase64(s)}`);
  }
  lines.push('end');
  return lines.join('\n') + '\n';
}

/** Read a manifest back (clients use it to match cells); throws on anything malformed. */
export function parseManifest(text: string): Manifest {
  const lines = text.split('\n');
  if (lines[0] !== MANIFEST_HEADER) throw new Error('not an md-runbook manifest (or a newer version)');
  const m: Manifest = { name: '', version: 0, scopes: [], patterns: {}, cells: [] };
  let cell: ManifestCell | undefined;
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
  for (const line of lines.slice(1)) {
    if (ended) {
      if (line !== '') throw new Error('manifest: text after end');
      continue;
    }
    if (line === '') continue;
    const [key, a, b, ...more] = line.split(' ');
    if (more.length > 0 && key !== 'scope') throw new Error(`manifest: bad line "${line.slice(0, 40)}"`);
    switch (key) {
      case 'name':
        m.name = a ?? '';
        break;
      case 'version':
        m.version = Number(a);
        break;
      case 'expires':
        m.expires = a;
        break;
      case 'scope':
        m.scopes = line.split(' ').slice(1);
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
export const signerLabel = (name: string): string => name.replace(/[^\w@.+-]+/g, '_').replace(/-{2,}/g, '-') || 'unknown';

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
  for (const line of text.split('\n')) {
    const bare = line.replace(/\r$/, '');
    if (open) {
      inCode.add(offset);
      if (isFenceClose(bare, open)) open = null;
    } else open = matchFenceOpen(bare);
    offset += line.length + 1;
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
  const manifest = fromBase64(m[3]!.replace(/\s+/g, ''));
  if (manifest === undefined) return undefined;
  const cosigners = [...(m[5] ?? '').trim().matchAll(COSIGN_RE)].map((c) => ({ signer: c[1]!, signed: c[2]!, signature: c[3]!.replace(/\s+/g, '') }));
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
  const built = buildManifest(text, { name: m.name, version: m.version, ...(m.expires ? { expires: m.expires } : {}), scopes: m.scopes, patterns: m.patterns });
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
}

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
    const k = free.findIndex((m) => m.info === c.info && m.code === code);
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
  return { block, manifest, cells, changed, missing: free.map((m) => m.n), moved };
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

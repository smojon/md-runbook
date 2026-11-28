/**
 * `md-runbook run --allowed-signers FILE`: run a signed runbook only as signed, as a server with
 * md-runbook-gate would, on this machine. Before anything runs: its signature is good (by a key in
 * FILE), nothing changed or moved since signing, it hasn't expired, every block that would run is
 * signed, and each parameter matches its signed pattern. Runbook calls follow: the runbook a call
 * names must be inside the repository, signed, and pass the same checks with the values passed
 * (checked before the run when they are known then; else when the call runs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCodeMeta, locateCodeCells, parse, shellKindForLanguage } from '@md-runbook/core';
import { callRefs, fillRefs, parseCall } from '@md-runbook/core/call';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { callTarget, manifestHash, samePath } from '@md-runbook/core/node';
import { cliSshVerify } from './allowedSignersFile';
import { v1FrontMatterProblems } from '@md-runbook/core/frontMatterRun';
import { currentOs } from '@md-runbook/core/os';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { allSignatures, signedStatus } from '@md-runbook/core/signing';
import { matchesSignedPattern } from '@md-runbook/core/signedPattern';

/** The repository a runbook is in (the nearest folder with .git), else its own folder. */
export function repositoryRoot(file: string): string {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(path.resolve(file));
    dir = up;
  }
}

/** Whether `file` is inside `root`. */
export function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(root, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Whether a value matches a signed pattern as the gate checks it (the whole value, byte for byte,
 * only patterns grep, the gate and clients read alike: core's signedPattern.ts). Before, the
 * pattern went into a JavaScript RegExp as written: `a)|(b` left the anchors (review of 0.28.0).
 */
export function matchesPattern(value: string, pattern: string): boolean {
  return matchesSignedPattern(pattern, value);
}

/**
 * Why a signed block can't get this value, as the gate checks the values it is given: no pattern
 * is signed under the name (the gate refuses a name its manifest has none for), or the value
 * doesn't match it. undefined when it matches. Inputs and captured values too: before, a signed
 * run checked only parameters (review, 2026-11-28).
 */
export function signedValueProblem(patterns: Readonly<Record<string, string>>, ref: { kind: string; name: string }, value: string): string | undefined {
  const re = Object.prototype.hasOwnProperty.call(patterns, ref.name) ? patterns[ref.name] : undefined;
  if (re === undefined) return `\${${ref.kind}:${ref.name}} has no signed pattern, so a signed run takes no value for it`;
  return matchesPattern(value, re) ? undefined : `${ref.name}=${JSON.stringify(value)} doesn't match its signed pattern ${re}`;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export interface SignedCheck {
  /** Each problem, naming the file. */
  problems: string[];
  /** Who signed it (the key's principal), when it verified. */
  signer?: string;
}

/**
 * What a gate's gate.conf would also require, for `md-runbook run` (review, 2026-11-28): each
 * applies to the runbook run and to those its calls run, except `name`, which only the runbook
 * named on the command line must have.
 */
export interface SignedPolicy {
  /** `--signers N`: that many distinct trusted signers (gate.conf `signers`). */
  signers?: number;
  /** `--name NAME`: the signed name must be this. */
  name?: string;
  /** `--revoked FILE`: manifest hashes withdrawn, one per line (gate.conf `revoked`). */
  revoked?: string;
  /** `--floors FILE`: `NAME LOWEST` per line; lower versions are withdrawn (gate.conf `floors`). */
  floors?: string;
  /** `--scope S`: the scopes accepted, or `*` (gate.conf `scopes`). */
  scopes?: string[];
}

/**
 * Whether the manifest's sha256 is in a revoked list, as md-runbook-gate reads it (requests.go
 * revoked): one hash per line, blanks, CR, upper case and a `sha256:` prefix tolerated.
 */
export function isRevoked(list: string, hash: string): boolean {
  return list.split('\n').some((l) => l.replace(/[\r \t]/g, '').toLowerCase().replace(/^sha256:/, '') === hash);
}

/**
 * The lowest version of `name` in a floors list, as md-runbook-gate reads it (requests.go
 * floorOf): `NAME LOWEST` per line, `#` starts a comment, the first such line counts. undefined
 * for none; a string that isn't digits never matches (as on the gate).
 */
export function floorOf(list: string, name: string): string | undefined {
  for (const raw of list.replace(/\r/g, '').split('\n')) {
    const f = raw.replace(/#.*$/, '').trim().split(/[ \t]+/);
    if (f.length >= 2 && f[0] === name && /^[0-9]*$/.test(f[1]!)) return f[1];
  }
  return undefined;
}

/**
 * Whether a server accepting `accepted` (`*`: any) runs a manifest with these scopes, as
 * md-runbook-gate decides (requests.go): one shared scope; a manifest without scopes only where
 * any is accepted.
 */
export function scopeAccepted(accepted: readonly string[], scopes: readonly string[]): boolean {
  if (accepted.includes('*')) return true;
  return scopes.some((s) => accepted.includes(s));
}

/** The policy's problems with a manifest (`hash`: its sha256; `signers`: the distinct trusted principals). */
function policyProblems(p: SignedPolicy, m: { name: string; version: number; scopes: string[] }, hash: string, signers: number): string[] {
  const out: string[] = [];
  const which = `${m.name} version ${m.version}`;
  if (p.name !== undefined && m.name !== p.name) out.push(`it is signed as ${m.name}, not ${p.name} (--name)`);
  if (p.signers !== undefined && signers < p.signers) out.push(`${which} needs ${p.signers} signers (--signers); signed by ${signers} trusted`);
  const read = (file: string, what: string): string | undefined => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      out.push(`can't read the ${what} list ${file}`);
      return undefined;
    }
  };
  if (p.revoked !== undefined) {
    const list = read(p.revoked, 'revoked');
    if (list !== undefined && isRevoked(list, hash)) out.push(`${which} was withdrawn (revoked in ${p.revoked})`);
  }
  if (p.floors !== undefined) {
    const list = read(p.floors, 'floors');
    const floor = list === undefined ? undefined : floorOf(list, m.name);
    if (floor !== undefined && floor !== '' && m.version < Number(floor)) out.push(`${which} is older than the lowest version allowed (${floor}, in ${p.floors})`);
  }
  if (p.scopes !== undefined && !scopeAccepted(p.scopes, m.scopes))
    out.push(`${m.name} is for ${m.scopes.length ? m.scopes.join(' ') : 'no scope'}; this run accepts ${p.scopes.join(' ')} (--scope)`);
  return out;
}

/**
 * The checks of a signed run of `file` with these parameter values (undefined: not known yet).
 * `shown` names it in messages; `depth` limits how far calls are followed (they are checked again
 * when they run). `opts.text`: the file as the run will use it (else it is read here).
 */
export async function checkSignedRun(
  file: string,
  params: Readonly<Record<string, string | undefined>>,
  allowedSigners: string,
  root: string,
  opts: { shown?: string; depth?: number; sshKeygen?: string; text?: string; policy?: SignedPolicy } = {},
): Promise<SignedCheck> {
  const shown = opts.shown ?? path.basename(file);
  const problems: string[] = [];
  const say = (p: string): void => void problems.push(`${shown}: ${p}`);
  const text = opts.text ?? fs.readFileSync(file, 'utf8');
  const status = signedStatus(text);
  if (!status) {
    say(/<!-- md-runbook:signature/.test(text) ? 'the signature block is damaged' : 'not signed (md-runbook sign)');
    return { problems };
  }
  const m = status.manifest;
  // The signature, by a key the allowed signers file names. Each one counts once per principal,
  // as on the gate (--signers N); without it the first good one is enough.
  const principals = new Set<string>();
  const why: string[] = [];
  for (const sig of allSignatures(status.block)) {
    try {
      principals.add(await cliSshVerify(status.block.manifest, sig, allowedSigners, opts.sshKeygen));
      if (opts.policy?.signers === undefined) break;
    } catch (e) {
      why.push(e instanceof Error ? e.message : String(e));
    }
  }
  const signer = [...principals][0];
  if (!signer) say(`its signature is not good: ${why.join('; ')}`);
  else if (opts.policy) for (const p of policyProblems(opts.policy, m, manifestHash(status.block.manifest), principals.size)) say(p);
  if (m.expires && m.expires < today()) say(`its signature expired on ${m.expires}`);
  const lines = new Map(locateCodeCells(parse(text)).map((l) => [l.cellIndex, l.line + 1]));
  for (const i of status.changed) say(`line ${lines.get(i) ?? '?'}: changed since signing (or never signed)`);
  for (const i of status.moved) say(`line ${lines.get(i) ?? '?'}: moved since signing`);
  if (status.missing.length) say(`signed block${status.missing.length === 1 ? '' : 's'} ${status.missing.join(', ')} not in the file as signed`);
  if (status.missingCalls.length) say(`signed runbook call${status.missingCalls.length === 1 ? '' : 's'} ${status.missingCalls.join(', ')} not in the file as signed`);
  // Only signed blocks run: bash/sh cells and calls are signed, other shells never are.
  // The front matter changes how every cell runs (env: BASH_ENV, cwd:, shell:, …): only a
  // whole-runbook signature (manifest version 2) covers it, and only while the text is as signed
  // (security review, 2026-11-16).
  if (status.version === 2 && status.textChanged) {
    say('changed since signing outside its blocks (front matter or text): sign it again');
  } else if (status.version !== 2) {
    // The same allow-list as links (core/runbookLink.ts linkTrust).
    const set = v1FrontMatterProblems(text);
    if (set.length) say(`its front matter has ${set.join(', ')}, which its signature (manifest version 1) doesn't cover: sign it again`);
  }
  const doc = parse(text);
  doc.cells.forEach((c, i) => {
    if (c.kind !== 'code' || !isCodeMeta(c.meta)) return;
    const o = parseCellOptions(c.meta.info);
    if (o.skip || o.host || (o.os && !o.os.includes(currentOs()))) return;
    const shell = shellKindForLanguage(c.languageId);
    if (shell && shell !== 'bash') say(`line ${lines.get(i) ?? '?'}: a ${c.meta.lang} block is never signed (only bash/sh blocks are): it can't run in a signed run`);
  });
  // Parameters: each value against its signed pattern.
  const fm = parseFrontMatter(text);
  const valueOf = (name: string): string | undefined => params[name] ?? fm?.params.find((p) => p.name === name)?.default;
  for (const [name, re] of Object.entries(m.patterns)) {
    const v = valueOf(name);
    if (v !== undefined && !matchesPattern(v, re)) say(`${name}=${JSON.stringify(v)} doesn't match its signed pattern ${re}`);
  }
  // Runbook calls: inside the repository, and signed themselves (known now: followed here).
  if ((opts.depth ?? 0) < 3) {
    for (const [index, call] of status.calls) {
      const c = parseCall(call.info, call.body);
      if (c.src === undefined) continue;
      const known = callRefs(c).every((r) => r.kind === 'param' && valueOf(r.name) !== undefined);
      if (!known) continue; // ${out:} or ${input:}: checked when the call runs
      const fill = (t: string): string => {
        const r = fillRefs(t, (_k, n) => valueOf(n));
        return 'text' in r ? r.text : t;
      };
      const target = callTarget(file, fill(c.src));
      const where = `line ${lines.get(index) ?? '?'}: the runbook call of ${fill(c.src)}`;
      if (!insideRoot(root, target)) {
        say(`${where} leaves the repository (${root}): a signed runbook calls runbooks in its own repository`);
        continue;
      }
      if (!fs.existsSync(target)) {
        say(`${where}: no such runbook`);
        continue;
      }
      if (samePath(target, file)) continue; // a cycle: the run refuses it
      const passed: Record<string, string> = {};
      for (const a of c.args) passed[a.name] = fill(a.value);
      // The policy holds for the runbooks called too, but not --name: they have their own.
      const policy = opts.policy ? { ...opts.policy, name: undefined } : undefined;
      const child = await checkSignedRun(target, passed, allowedSigners, root, { ...opts, policy, text: undefined, shown: path.relative(path.dirname(file), target).split(path.sep).join('/'), depth: (opts.depth ?? 0) + 1 });
      problems.push(...child.problems);
    }
  }
  return { problems, ...(signer ? { signer } : {}) };
}

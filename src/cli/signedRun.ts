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
import { callTarget, samePath, sshVerify } from '@md-runbook/core/node';
import { currentOs } from '@md-runbook/core/os';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { allSignatures, signedStatus } from '@md-runbook/core/signing';

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

/** Whether a value matches a signed pattern as the gate checks it (the whole value, grep -E). */
export function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value) && !/[\r\n]/.test(value);
  } catch {
    return false;
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);

export interface SignedCheck {
  /** Each problem, naming the file. */
  problems: string[];
  /** Who signed it (the key's principal), when it verified. */
  signer?: string;
}

/**
 * The checks of a signed run of `file` with these parameter values (undefined: not known yet).
 * `shown` names it in messages; `depth` limits how far calls are followed (they are checked again
 * when they run).
 */
export async function checkSignedRun(
  file: string,
  params: Readonly<Record<string, string | undefined>>,
  allowedSigners: string,
  root: string,
  opts: { shown?: string; depth?: number; sshKeygen?: string } = {},
): Promise<SignedCheck> {
  const shown = opts.shown ?? path.basename(file);
  const problems: string[] = [];
  const say = (p: string): void => void problems.push(`${shown}: ${p}`);
  const text = fs.readFileSync(file, 'utf8');
  const status = signedStatus(text);
  if (!status) {
    say(/<!-- md-runbook:signature/.test(text) ? 'the signature block is damaged' : 'not signed (md-runbook sign)');
    return { problems };
  }
  const m = status.manifest;
  // The signature, by a key the allowed signers file names.
  let signer: string | undefined;
  const why: string[] = [];
  for (const sig of allSignatures(status.block)) {
    try {
      signer = await sshVerify(status.block.manifest, sig, allowedSigners, opts.sshKeygen);
      break;
    } catch (e) {
      why.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!signer) say(`its signature is not good: ${why.join('; ')}`);
  if (m.expires && m.expires < today()) say(`its signature expired on ${m.expires}`);
  const lines = new Map(locateCodeCells(parse(text)).map((l) => [l.cellIndex, l.line + 1]));
  for (const i of status.changed) say(`line ${lines.get(i) ?? '?'}: changed since signing (or never signed)`);
  for (const i of status.moved) say(`line ${lines.get(i) ?? '?'}: moved since signing`);
  if (status.missing.length) say(`signed block${status.missing.length === 1 ? '' : 's'} ${status.missing.join(', ')} not in the file as signed`);
  if (status.missingCalls.length) say(`signed runbook call${status.missingCalls.length === 1 ? '' : 's'} ${status.missingCalls.join(', ')} not in the file as signed`);
  // Only signed blocks run: bash/sh cells and calls are signed, other shells never are.
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
      const child = await checkSignedRun(target, passed, allowedSigners, root, { ...opts, shown: path.relative(path.dirname(file), target).split(path.sep).join('/'), depth: (opts.depth ?? 0) + 1 });
      problems.push(...child.problems);
    }
  }
  return { problems, ...(signer ? { signer } : {}) };
}

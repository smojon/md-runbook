/**
 * Runbook calls in the app (core/call.ts): a ```runbook cell runs another runbook as one step.
 *
 * Where the runbook called comes from:
 * - a runbook opened from a web address (a link or QR code with url=): the address next to it,
 *   downloaded like the link (same site, and on GitHub or GitLab the same repository and version);
 * - a runbook opened from a file: the person picks the file once (its name must match), and the
 *   app remembers it for this runbook.
 *
 * As in VS Code, the runbook called runs as a copy (`<file>.<yyyyMMdd-HHmmss>.md`, a runbook of
 * its own in the app's list), with only the parameters the call passes: its screen opens and runs
 * the steps of the call's sections. When that run ends, the call's cell gets the result (runbook=,
 * copy=, steps=, sha256=). A call that failed continues in its copy when run again.
 */

import {
  DEFAULT_WRITE_OPTIONS,
  clearOutputBlocks,
  copyFileName,
  formatDurationAttr,
  formatLocalIso,
  isCodeMeta,
  locateCodeCells,
  parse,
  setCellOutput,
  stepState,
  taskItems,
} from '@md-runbook/core';
import { resolveKubeContext, wantedKubeContext } from '@md-runbook/core/kubeContext';
import { signedStatus } from '@md-runbook/core/signing';
import {
  CallResult,
  callAttrs,
  callChainProblem,
  callFromAttrs,
  callOutputText,
  callRefs,
  checkCall,
  fillRefs,
  isCallLanguage,
  parseCall,
  recordValues,
} from '@md-runbook/core/call';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { withFrontMatterValues } from '@md-runbook/core/incident';
import { osGroups } from '@md-runbook/core/os';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { inSections, sectionHeadings } from '@md-runbook/core/sections';
import { sha256Hex } from '@md-runbook/core/sha256';
import { useSyncExternalStore } from 'react';
import type { CallReader } from '@md-runbook/core/estimate';
import { t } from '../i18n';
import { askAutorun } from './autorun';
import { pickRunbookFile } from './files';
import { checkParam, setParamValue } from './params';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook, getRunbook, linkKey, runbookNamed, updateRunbookText } from './store';

/** A call that is running in its copy: what to write back, and where. */
export interface ActiveCall {
  parentId: string;
  cellIndex: number;
  /** src= as resolved (shown, and recorded as runbook=). */
  runbook: string;
  sections: string[];
  /** Continuing the copy of a failed run: the steps done there are kept. */
  resumed: boolean;
  started: Date;
  /** The runbooks calling it, the first the one opened (cycles, depth). */
  callers: string[];
}

const active = new Map<string, ActiveCall>();
/** The runbooks calls named, as downloaded (by address) or picked (`${parentId}\n${src}`), for lint and estimates. */
const texts = new Map<string, string>();
const fetching = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
const changed = (): void => {
  version++;
  listeners.forEach((l) => l());
};

/** Changes when a runbook a call names arrives (lint and estimates read it then). */
export function useCalledTexts(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
}

/**
 * Reads the runbooks the calls of `r` name, as far as the app has them now: next to its web
 * address (downloaded), or picked for it; never asks or downloads.
 */
// `version` (useCalledTexts) makes a new reader when a runbook arrives, so lint and estimates run again.
export function callReader(r: Runbook, version?: number): CallReader {
  void version;
  return (src, from) => {
    const base = from ?? webAddressOf(r);
    if (base) {
      const url = calledAddress(base, src);
      const text = url ? texts.get(url) : undefined;
      return text === undefined ? undefined : { text, at: url! };
    }
    const text = from === undefined ? texts.get(`${r.id}\n${src}`) : undefined;
    return text === undefined ? undefined : { text };
  };
}

/** Download (once) the runbooks the calls of a runbook opened from a web address name, when src= is fixed, and theirs. */
export function prefetchCalls(r: Runbook, fetcher: typeof fetch = fetch): void {
  const base = webAddressOf(r);
  if (!base) return;
  const walk = (text: string, at: string, depth: number): void => {
    if (depth >= 3) return;
    for (const c of parse(text).cells) {
      if (c.kind !== 'code' || !isCodeMeta(c.meta) || !isCallLanguage(c.languageId)) continue;
      const src = parseCall(c.meta.info, c.value).src;
      if (src === undefined || /\$\{/.test(src)) continue;
      const url = calledAddress(at, src);
      if (!url) continue;
      const known = texts.get(url);
      if (known !== undefined) {
        walk(known, url, depth + 1);
        continue;
      }
      if (fetching.has(url)) continue;
      fetching.add(url);
      void fetcher(url)
        .then(async (res) => (res.ok ? res.text() : undefined))
        .then((t) => {
          if (t === undefined || t.length > MAX_RUNBOOK_BYTES) return;
          texts.set(url, t);
          changed();
          walk(t, url, depth + 1);
        })
        .catch(() => undefined)
        .finally(() => fetching.delete(url));
    }
  };
  walk(r.text, base, 0);
}
/** Runbook files picked for a call of a runbook opened from a file: `${parentId}\n${src}` → the text. */
const picked = new Map<string, { name: string; text: string }>();

/** The call a copy runs for, while it runs. */
export function activeCall(copyId: string): ActiveCall | undefined {
  return active.get(copyId);
}

/** The web address a runbook was opened from (url= links), if any. */
export function webAddressOf(r: Runbook): string | undefined {
  const source = r.link?.split(' ')[0];
  return source && /^https:\/\//i.test(source) ? source : undefined;
}

/** The address of `src` next to `base`, if it stays on the same site (and repository, on GitHub and GitLab). */
export function calledAddress(base: string, src: string): string | undefined {
  let b: URL;
  let u: URL;
  try {
    b = new URL(base);
    u = new URL(src, b);
  } catch {
    return undefined;
  }
  if (u.origin !== b.origin || u.protocol !== 'https:') return undefined;
  // raw.githubusercontent.com/OWNER/REPO/REF/… and gitlab.com/OWNER/REPO/-/raw/REF/…: not outside it.
  const parts = b.pathname.split('/').filter(Boolean);
  const keep = b.hostname === 'raw.githubusercontent.com' ? 3 : parts.indexOf('raw') > 0 ? parts.indexOf('raw') + 2 : 0;
  const prefix = '/' + parts.slice(0, keep).join('/');
  if (keep > 0 && !u.pathname.startsWith(prefix + '/')) return undefined;
  return u.toString();
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A runbook in a chain of calls: its web address when it has one, else its file name. */
const identity = (name: string, address: string | undefined): string => address ?? baseName(name);

type Got = { kind: 'got'; text: string; source?: string } | { kind: 'error'; message: string } | { kind: 'canceled' };

/** The runbook a call names: next to the web address the caller came from, else a file picked once. */
async function calledText(parent: Runbook, src: string, fetcher: typeof fetch): Promise<Got> {
  const base = webAddressOf(parent);
  if (base) {
    const url = calledAddress(base, src);
    if (!url) return { kind: 'error', message: t.callOutside(src) };
    try {
      const res = await fetcher(url);
      if (!res.ok) return { kind: 'error', message: t.callFetchFailed(src, `HTTP ${res.status}`) };
      const text = await res.text();
      if (text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(baseName(src)) };
      texts.set(url, text);
      changed();
      return { kind: 'got', text, source: url };
    } catch (e) {
      return { kind: 'error', message: t.callFetchFailed(src, e instanceof Error ? e.message : String(e)) };
    }
  }
  const key = `${parent.id}\n${src}`;
  const known = picked.get(key);
  if (known) return { kind: 'got', text: known.text };
  const p = await pickRunbookFile();
  if (p.kind === 'canceled') return { kind: 'canceled' };
  if (p.kind === 'error') return { kind: 'error', message: p.message };
  if (p.name.toLowerCase() !== baseName(src).toLowerCase()) return { kind: 'error', message: t.callWrongFile(p.name, baseName(src)) };
  if (p.text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(p.name) };
  picked.set(key, { name: p.name, text: p.text });
  texts.set(key, p.text);
  changed();
  return { kind: 'got', text: p.text };
}

/** The copy of an earlier run of the call, if it failed and the app still has it. */
function earlierCopy(parent: Runbook, cellIndex: number, runbook: string): Runbook | undefined {
  const cell = parse(parent.text).cells[cellIndex];
  const prev = callFromAttrs(cell?.output?.attrs);
  if (!prev || prev.exit === undefined || prev.exit === '0' || prev.runbook !== runbook) return undefined;
  return runbookNamed(prev.copy);
}

export type StartResult = { kind: 'started'; copyId: string; resumed: boolean } | { kind: 'error'; message: string } | { kind: 'canceled' };

/**
 * Start the call in cell `cellIndex` of `parent`: its copy (new, or the one a failed run left) is
 * made, given the parameters, and asked to run when its screen opens. `values` are the caller's
 * values for the call's placeholders (parameters, captures, inputs).
 */
export async function startCall(
  parent: Runbook,
  cellIndex: number,
  values: Readonly<Record<string, string>>,
  opts: { fetcher?: typeof fetch; fresh?: boolean } = {},
): Promise<StartResult> {
  const fetcher = opts.fetcher ?? fetch;
  const cell = parse(parent.text).cells[cellIndex];
  if (!cell || cell.kind !== 'code' || !isCodeMeta(cell.meta) || !isCallLanguage(cell.languageId))
    return { kind: 'error', message: t.callNotACall };
  const call = parseCall(cell.meta.info, cell.value);
  if (call.problems.length > 0 || call.src === undefined) return { kind: 'error', message: call.problems.map((p) => p.message).join('; ') };
  let missing: string | undefined;
  try {
    for (const ref of callRefs(call)) if (values[ref.name] === undefined) missing ??= ref.name;
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (missing) return { kind: 'error', message: t.callNeedsValue(missing) };
  const fill = (text: string): string => {
    const r = fillRefs(text, (_kind, name) => values[name]);
    return 'text' in r ? r.text : text;
  };
  const src = fill(call.src);
  const sections = call.sections;
  // Signed: the call as signed, its values as the signature allows (the gate never sees a call).
  const signed = signedStatus(parent.text);
  if (signed) {
    if (!signed.calls.has(cellIndex)) return { kind: 'error', message: t.callChangedSinceSigned };
    const used = new Set(callRefs(call).map((r) => r.name));
    for (const [name, pattern] of Object.entries(signed.manifest.patterns)) {
      const v = values[name];
      if (v !== undefined && used.has(name) && checkParam({ name, pattern }, v))
        return { kind: 'error', message: t.callValueOffPattern(name, pattern) };
    }
  }
  // Cycles and depth: the runbooks calling this one, by where they came from.
  const base = webAddressOf(parent);
  const caller = active.get(parent.id);
  const callers = caller ? [...caller.callers, identity(caller.runbook, base)] : [identity(parent.fileName ?? parent.title, base)];
  const chain = callChainProblem(callers, identity(src, base ? calledAddress(base, src) : undefined));
  if (chain) return { kind: 'error', message: chain };
  const again = opts.fresh ? undefined : earlierCopy(parent, cellIndex, src);
  let copy: Runbook;
  if (again) copy = again;
  else {
    const got = await calledText(parent, src, fetcher);
    if (got.kind !== 'got') return got;
    const check = checkCall(call, got.text);
    const refusal = [...check.unknown.map((a) => t.callNoParam(src, a.name)), ...check.sections];
    if (refusal.length > 0) return { kind: 'error', message: refusal.join('; ') };
    // A signed runbook calls signed runbooks only, unchanged since signing.
    if (signed) {
      const child = signedStatus(got.text);
      if (!child) return { kind: 'error', message: t.callNotSigned(src) };
      if (child.changed.length || child.missing.length || child.moved.length || child.missingCalls.length)
        return { kind: 'error', message: t.callChildChanged(src) };
    }
    // The cluster: the runbook called names the caller's, or none (then the caller's is its own).
    const passed: Record<string, string> = {};
    for (const a of call.args) passed[a.name] = fill(a.value);
    const parentFm = parseFrontMatter(parent.text);
    const childFm = parseFrontMatter(got.text);
    let mine: string | undefined;
    let theirs: string | undefined;
    try {
      mine = resolveKubeContext(wantedKubeContext(parseCellOptions(cell.meta.info), parentFm), (n) => values[n]);
      theirs = resolveKubeContext(childFm?.kubeContext, (n) => passed[n] ?? childFm?.params.find((p) => p.name === n)?.default);
    } catch {
      theirs = undefined; // a parameter it asks for: its own steps check the cluster
    }
    if (mine !== undefined && theirs !== undefined && mine !== theirs)
      return { kind: 'error', message: t.callOtherCluster(src, theirs, mine) };
    const record: Record<string, string> = {
      ...recordValues(parent.text),
      ...(mine !== undefined && !childFm?.kubeContext
        ? { 'kube-context': mine, ...(parentFm?.kubeContextMode ? { 'kube-context-mode': parentFm.kubeContextMode } : {}) }
        : {}),
    };
    const text = clearOutputBlocks(got.text);
    copy = addRunbook(
      copyFileName(baseName(src), new Date()),
      Object.keys(record).length ? withFrontMatterValues(text, record) : text,
      undefined,
      // Its own calls are next to it, as for the caller.
      got.source ? linkKey(got.source, got.text) : undefined,
    );
  }
  for (const a of call.args) setParamValue(copy.id, a.name, fill(a.value));
  active.set(copy.id, {
    parentId: parent.id,
    cellIndex,
    runbook: src,
    sections,
    resumed: again !== undefined,
    started: new Date(),
    callers,
  });
  askAutorun(copy.id);
  return { kind: 'started', copyId: copy.id, resumed: again !== undefined };
}

/** The cells of a copy a call runs: in its sections, and (continuing) not done there before. */
export function callCells(copyText: string, c: Pick<ActiveCall, 'sections' | 'resumed'>): number[] {
  const inPart = c.sections.length ? inSections(sectionHeadings(copyText), c.sections) : () => true;
  return locateCodeCells(parse(copyText))
    .filter((l) => inPart(l.line))
    .filter((l) => {
      if (!c.resumed) return true;
      const s = stepState(l.outputAttrs?.exit, l.outputAttrs?.lines !== undefined, l.outputAttrs?.check);
      return s !== 'done' && s !== 'skipped';
    })
    .map((l) => l.cellIndex);
}

/** The call's result, from its copy as it is now (no write). */
export function callResult(copy: Runbook, c: ActiveCall): { result: CallResult; ok: boolean; evidence: boolean } {
  const doc = parse(copy.text);
  const inPart = c.sections.length ? inSections(sectionHeadings(copy.text), c.sections) : () => true;
  const slots = osGroups(
    doc.cells.map((x) =>
      isCodeMeta(x.meta) ? { kind: 'code' as const, os: parseCellOptions(x.meta.info).os } : { kind: 'markup' as const },
    ),
    'linux',
  );
  const states = locateCodeCells(doc)
    .filter((l) => inPart(l.line) && !(slots[l.cellIndex] && !slots[l.cellIndex]!.active))
    .map((l) => stepState(l.outputAttrs?.exit, l.outputAttrs?.lines !== undefined, l.outputAttrs?.check));
  const unticked = taskItems(copy.text).filter((i) => !i.checked && inPart(i.line)).length;
  const evidence = parseFrontMatter(copy.text)?.evidence === true;
  const result: CallResult = {
    runbook: c.runbook,
    copy: copy.fileName ?? copy.id,
    sha256: sha256Hex(copy.text),
    done: states.filter((s) => s === 'done').length,
    skipped: states.filter((s) => s === 'skipped').length,
    failed: states.filter((s) => s === 'failed').length,
    notRun: states.filter((s) => s === 'pending').length,
    manual: unticked,
  };
  return { result, ok: result.failed === 0 && result.notRun === 0 && !(evidence && unticked > 0), evidence };
}

/** The copy's run ended: write the call's result into the caller's cell. Returns the caller and whether the call is done. */
export function finishCall(copyId: string, now = new Date()): { parentId: string; ok: boolean } | undefined {
  const c = active.get(copyId);
  const copy = getRunbook(copyId);
  if (!c || !copy) return undefined;
  active.delete(copyId);
  const parent = getRunbook(c.parentId);
  if (!parent) return undefined;
  const { result, ok, evidence } = callResult(copy, c);
  const note =
    evidence && result.manual && result.failed === 0 && result.notRun === 0
      ? `[md-runbook] ${t.callManualLeft(result.manual, copy.fileName ?? copy.title)}\n`
      : ok
        ? ''
        : `[md-runbook] ${c.runbook}: not done\n`;
  const attrs: Record<string, string> = {
    exit: ok ? '0' : '1',
    ran: formatLocalIso(c.started),
    ended: formatLocalIso(now),
    duration: formatDurationAttr(now.getTime() - c.started.getTime()),
    ...callAttrs(result),
  };
  const next = setCellOutput(
    parent.text,
    c.cellIndex,
    { kind: 'new', text: callOutputText(result, c.sections) + note, attrs },
    DEFAULT_WRITE_OPTIONS,
  );
  if (next !== undefined) updateRunbookText(parent.id, next);
  return { parentId: parent.id, ok };
}

/** For tests: forget the calls running and the files picked. */
export function resetCalls(): void {
  active.clear();
  picked.clear();
  texts.clear();
  fetching.clear();
}

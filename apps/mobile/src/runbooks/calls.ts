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
 * copy=, steps=, sha256=). A call that failed continues in its copy when run again, if that copy
 * is still a copy of the runbook called (core/callCopy.ts); otherwise a fresh copy runs, saying why.
 * A value in src= fills part of one file name (core srcValueProblem), checked before anything runs.
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
import { readSignature, signedStatus } from '@md-runbook/core/signing';
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
  isDynamicSrc,
  parseCall,
  recordValues,
  srcValueProblem,
} from '@md-runbook/core/call';
import { COPY_NOT_RECORDED, copyDigest, copyFrontMatterProblem, copyTextProblem, isCopyNameOf } from '@md-runbook/core/callCopy';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { withFrontMatterValues } from '@md-runbook/core/incident';
import { osGroups } from '@md-runbook/core/os';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { inSections, sectionHeadings } from '@md-runbook/core/sections';
import { sha256Hex } from '@md-runbook/core/sha256';
import { useSyncExternalStore } from 'react';
import type { CallReader } from '@md-runbook/core/estimate';
import { t } from '../i18n';
import { getJson, setJson } from '../storage/kv';
import { askAutorun } from './autorun';
import { pickRunbookFile } from './files';
import { CellRef, cellRef, resolveCell } from './cellRef';
import { checkParam, setParamValue } from './params';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook, getRunbook, linkKey, runbookNamed, updateRunbookText } from './store';

/** A call that is running in its copy: what to write back, and where. */
export interface ActiveCall {
  parentId: string;
  /** Where the call's cell was in the caller when the call started (shown; `cell` is what is acted on). */
  cellIndex: number;
  /** The call's cell by what it is: its result goes to it, wherever it is when the run ends. */
  cell: CellRef;
  /** src= as resolved (shown, and recorded as runbook=). */
  runbook: string;
  sections: string[];
  /** Continuing the copy of a failed run: the steps done there are kept. */
  resumed: boolean;
  started: Date;
  /** The runbooks calling it, the first the one opened (cycles, depth). */
  callers: string[];
  /** A setup call (core/parts.ts): the ready check of the runbook called runs first and guards the rest. */
  setup?: boolean;
  /** Why the copy of the failed run was not continued (a fresh copy runs): said in the call's output. */
  note?: string;
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

/**
 * The call copies this app wrote (core copyDigest), by the copy's id in the app, kept in the
 * app's own storage where no runbook can change them: written when a call makes its copy, after
 * each run in it and when the call ends. A copy is continued only as kept here.
 */
const COPIES_KEY = 'callCopies.v1';
const MAX_COPIES = 500;
const isDigests = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((d) => typeof d === 'string');
let copies: Record<string, string> = {};
let copiesLoaded: Promise<void> | undefined;

function loadCopies(): Promise<void> {
  copiesLoaded ??= getJson(COPIES_KEY, isDigests).then((saved) => {
    // What was written before the load is newer.
    copies = { ...(saved ?? {}), ...copies };
  });
  return copiesLoaded;
}

/** The copy `copyId` is as this app wrote it: `text` (after a run in it, or the call's end). */
export function recordCallCopy(copyId: string, text: string): void {
  const next = { ...copies };
  delete next[copyId];
  next[copyId] = copyDigest(text);
  copies = Object.fromEntries(Object.entries(next).slice(-MAX_COPIES));
  void loadCopies()
    .then(() => setJson(COPIES_KEY, copies))
    .catch((e: unknown) => console.warn('call copy record not saved', e));
}

/** Whether `copy` is as this app last wrote it. */
async function recordedHere(copy: Runbook): Promise<boolean> {
  await loadCopies();
  return copies[copy.id] === copyDigest(copy.text);
}

/**
 * Why `copy` can't be continued as the run copy of `src`, whose text is now `target` (core's
 * checks, as VS Code's resumeProblem and resumeRecordProblem): the output block naming it is never
 * signed. Its name must be a run copy's of that file, its blocks those of the runbook called and,
 * in a signed runbook, signed as the same name and version; its front matter the one a copy gets
 * now (`added`: the values the call writes into it); and its text the one a run in this app last
 * wrote (`recorded`). Undefined: it can.
 */
export function continueProblem(
  copy: Runbook,
  src: string,
  target: string,
  signed: boolean,
  added: Record<string, string>,
  recorded: boolean,
): string | undefined {
  const name = copy.fileName ?? copy.title;
  if (!isCopyNameOf(name, baseName(src), true)) return t.callCopyNotNamed(baseName(src));
  return (
    copyTextProblem(copy.text, target, signed) ??
    copyFrontMatterProblem(copy.text, target, added) ??
    (recorded ? undefined : COPY_NOT_RECORDED)
  );
}

/** The copy of an earlier run of the call, if it failed and the app still has it. */
function earlierCopy(parent: Runbook, cellIndex: number, runbook: string): Runbook | undefined {
  const cell = parse(parent.text).cells[cellIndex];
  const prev = callFromAttrs(cell?.output?.attrs);
  // A setup call skipped as already up is checked again, not continued.
  if (!prev || prev.exit === undefined || prev.exit === '0' || prev.exit === 'skipped' || prev.runbook !== runbook) return undefined;
  return runbookNamed(prev.copy);
}

export type StartResult =
  /** `note`: why the copy of the failed run was not continued. */
  { kind: 'started'; copyId: string; resumed: boolean; note?: string } | { kind: 'error'; message: string } | { kind: 'canceled' };

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
  const ref = cellRef(parent.text, cellIndex);
  if (!cell || !ref || cell.kind !== 'code' || !isCodeMeta(cell.meta) || !isCallLanguage(cell.languageId))
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
  // A value from a link, an alert or a parameter fills part of one file name, never another path
  // (core's srcValueProblem, as VS Code and the command line): nothing is fetched or picked.
  const leaves = isDynamicSrc(call.src) ? srcValueProblem(call.src, src) : undefined;
  if (leaves) return { kind: 'error', message: leaves };
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
  // The runbook called as it is now: its checks, and the one a copy to continue must still be.
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
  // A failed run's copy, continued only if it is still a copy of the runbook called, with the
  // front matter a copy gets now and the text this app last wrote into it.
  const earlier = opts.fresh ? undefined : earlierCopy(parent, cellIndex, src);
  let note: string | undefined;
  let again: Runbook | undefined;
  if (earlier) {
    const why = continueProblem(earlier, src, got.text, readSignature(parent.text) !== undefined, record, await recordedHere(earlier));
    if (why === undefined) again = earlier;
    else note = t.callNotContinued(earlier.fileName ?? earlier.title, why);
  }
  const text = clearOutputBlocks(got.text);
  const copy =
    again ??
    addRunbook(
      copyFileName(baseName(src), new Date()),
      Object.keys(record).length ? withFrontMatterValues(text, record) : text,
      undefined,
      // Its own calls are next to it, as for the caller.
      got.source ? linkKey(got.source, got.text) : undefined,
    );
  recordCallCopy(copy.id, copy.text);
  for (const a of call.args) setParamValue(copy.id, a.name, fill(a.value));
  active.set(copy.id, {
    parentId: parent.id,
    cellIndex,
    cell: ref,
    runbook: src,
    sections,
    resumed: again !== undefined,
    started: new Date(),
    callers,
    ...(parseCellOptions(cell.meta.info).part === 'setup' ? { setup: true } : {}),
    ...(note ? { note } : {}),
  });
  askAutorun(copy.id);
  return { kind: 'started', copyId: copy.id, resumed: again !== undefined, ...(note ? { note } : {}) };
}

/**
 * The cells of a copy a call runs: in its sections, and (continuing) not done there before. A
 * setup call runs the ready check first, whatever its sections are.
 */
export function callCells(copyText: string, c: Pick<ActiveCall, 'sections' | 'resumed' | 'setup'>): number[] {
  const inPart = c.sections.length ? inSections(sectionHeadings(copyText), c.sections) : () => true;
  const locs = locateCodeCells(parse(copyText));
  const ready = c.setup ? readyCellOf(copyText) : undefined;
  const cells = locs
    .filter((l) => inPart(l.line) && l.cellIndex !== ready)
    .filter((l) => {
      if (!c.resumed) return true;
      const s = stepState(l.outputAttrs?.exit, l.outputAttrs?.lines !== undefined, l.outputAttrs?.check);
      return s !== 'done' && s !== 'skipped';
    })
    .map((l) => l.cellIndex);
  return ready !== undefined ? [ready, ...cells] : cells;
}

/** The cell index of a runbook's ready check (core/parts.ts), if it has one. */
export function readyCellOf(text: string): number | undefined {
  return locateCodeCells(parse(text)).find((l) => parseCellOptions(l.info).part === 'ready')?.cellIndex;
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

/**
 * The copy's run ended: write the call's result into the caller's cell. Returns the caller and
 * whether the call is done; `gone` when the call's cell changed or went in the caller meanwhile
 * (nothing is written then: never a result on another cell).
 */
export function finishCall(copyId: string, now = new Date()): { parentId: string; ok: boolean; gone?: true } | undefined {
  const c = active.get(copyId);
  const copy = getRunbook(copyId);
  if (!c || !copy) return undefined;
  active.delete(copyId);
  // As this run left it: the next run of the call may continue it, as long as it stays so.
  recordCallCopy(copyId, copy.text);
  const parent = getRunbook(c.parentId);
  if (!parent) return undefined;
  const at = resolveCell(parent.text, c.cell);
  if (at === undefined) return { parentId: parent.id, ok: false, gone: true };
  const { result, ok, evidence } = callResult(copy, c);
  // A setup call whose runbook's ready check said up: already up, and the call is skipped.
  const ready = c.setup ? readyCellOf(copy.text) : undefined;
  const up = ok && ready !== undefined && parse(copy.text).cells[ready]?.output?.attrs.ready === 'up';
  const note =
    evidence && result.manual && result.failed === 0 && result.notRun === 0
      ? `[md-runbook] ${t.callManualLeft(result.manual, copy.fileName ?? copy.title)}\n`
      : up
        ? `[md-runbook] ${t.callAlreadyUp(c.runbook)}\n`
        : ok
          ? ''
          : `[md-runbook] ${c.runbook}: not done\n`;
  const attrs: Record<string, string> = {
    exit: up ? 'skipped' : ok ? '0' : '1',
    ...(up ? { ready: 'up' } : {}),
    ran: formatLocalIso(c.started),
    ended: formatLocalIso(now),
    duration: formatDurationAttr(now.getTime() - c.started.getTime()),
    ...callAttrs(result),
  };
  const next = setCellOutput(
    parent.text,
    at,
    { kind: 'new', text: (c.note ? `[md-runbook] ${c.note}\n` : '') + callOutputText(result, c.sections) + note, attrs },
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
  copies = {};
  copiesLoaded = undefined;
}

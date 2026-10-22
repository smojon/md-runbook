/**
 * Runbook parameters in the app: the `${param:NAME}` values a runbook's cells use. The names come
 * from the front matter's `params:` (with their defaults) and from the cells themselves; a signed
 * runbook adds the pattern each value must match, which md-runbook-gate checks again on the
 * server. The values the user types are remembered per runbook (they are not secrets).
 */
import { useSyncExternalStore } from 'react';
import { ParsedCell, parse, shellKindForLanguage } from '@md-runbook/core';
import { findRefs, parseFrontMatter } from '@md-runbook/core/secrets';
import { signedStatus } from '@md-runbook/core/signing';
import { getJson, setJson } from '../storage/kv';

export interface ParamSpec {
  name: string;
  /** The front matter's default. */
  default?: string;
  /** From the runbook's signature: a POSIX extended regular expression for the whole value. */
  pattern?: string;
}

const isBash = (c: ParsedCell): boolean => c.kind === 'code' && shellKindForLanguage(c.languageId) === 'bash';

/** The parameters of a runbook, in order: declared ones first, then any other the cells use. */
export function runbookParams(text: string): ParamSpec[] {
  const specs = new Map<string, ParamSpec>();
  for (const p of parseFrontMatter(text)?.params ?? [])
    specs.set(p.name, { name: p.name, ...(p.default !== undefined ? { default: p.default } : {}) });
  for (const cell of parse(text).cells.filter(isBash)) {
    for (const ref of refsOf(cell.value)) if (ref.kind === 'param' && !specs.has(ref.name)) specs.set(ref.name, { name: ref.name });
  }
  const patterns = signedStatus(text)?.manifest.patterns ?? {};
  for (const [name, pattern] of Object.entries(patterns)) {
    const s = specs.get(name);
    if (s) s.pattern = pattern;
  }
  return [...specs.values()];
}

/** References of a cell; none when they are malformed (lint reports those). */
export function refsOf(source: string): ReturnType<typeof findRefs> {
  try {
    return findRefs(source);
  } catch {
    return [];
  }
}

/**
 * Why `value` is not acceptable, or undefined. The pattern is POSIX ERE (what the gate uses); the
 * app checks it as a JavaScript regular expression, which agrees for the usual patterns, and
 * leaves the final word to the gate when it can't read one.
 */
export function checkParam(spec: ParamSpec, value: string): 'newline' | 'pattern' | undefined {
  if (/[\r\n]/.test(value)) return 'newline';
  if (spec.pattern === undefined) return undefined;
  // POSIX classes mean something else in JavaScript ([[:alpha:]] is a class of `[:alph` there).
  const source = spec.pattern.replace(/\[:([a-z]+):\]/g, (m, n: string) => POSIX_CLASSES[n] ?? m);
  if (source.includes('[:')) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`);
  } catch {
    return undefined;
  }
  return re.test(value) ? undefined : 'pattern';
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  xdigit: '0-9A-Fa-f',
  space: ' \\t\\r\\n\\f\\v',
  blank: ' \\t',
};

// ---- the values, per runbook ----

type Values = Record<string, string>;
const isValues = (v: unknown): v is Values => typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'string');
const keyOf = (runbookId: string): string => `params.v1.${runbookId}`;

const values = new Map<string, Values>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const EMPTY: Values = {};

function load(runbookId: string): void {
  if (values.has(runbookId) || loading.has(runbookId)) return;
  loading.add(runbookId);
  void getJson(keyOf(runbookId), isValues).then((v) => {
    loading.delete(runbookId);
    // A value typed meanwhile wins over the stored one.
    values.set(runbookId, { ...(v ?? {}), ...(values.get(runbookId) ?? {}) });
    emit();
  });
}

/** The values typed for a runbook (not the defaults). */
export function paramValues(runbookId: string): Values {
  load(runbookId);
  return values.get(runbookId) ?? EMPTY;
}

export function setParamValue(runbookId: string, name: string, value: string): void {
  const next = { ...(values.get(runbookId) ?? {}), [name]: value };
  values.set(runbookId, next);
  emit();
  void setJson(keyOf(runbookId), next).catch((e: unknown) => console.warn('parameters not saved', e));
}

export function useParamValues(runbookId: string): Values {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => paramValues(runbookId),
  );
}

/** Tests: forget every value. */
export function resetParamValues(): void {
  values.clear();
  loading.clear();
  emit();
}

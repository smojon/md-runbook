/**
 * What the app sends to an AI, built as the extension builds it (core buildAiContext): outputs
 * redacted, shortened and marked as untrusted, names pseudonymized with a map that stays on the
 * device, so answers can be mapped back. The leak check runs on the same text before anything
 * leaves the device.
 */
import { DEFAULT_PATTERNS, createRedactor } from '@md-runbook/core';
import { AiContext, DEFAULT_COPY_HEADER, PseudonymMap, buildAiContext, emptyMap } from '@md-runbook/core/aiContext';
import { LeakFinding, scanForLeaks } from '@md-runbook/core/leaks';
import { getJson, setJson } from '../storage/kv';

const MAP_KEY = 'ai.pseudonyms.v1';
const isMap = (v: unknown): v is PseudonymMap =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as PseudonymMap).forward === 'object' &&
  Object.values((v as PseudonymMap).forward).every((a) => typeof a === 'string');

let map: PseudonymMap | undefined;
async function currentMap(): Promise<PseudonymMap> {
  map ??= (await getJson(MAP_KEY, isMap)) ?? emptyMap();
  return map;
}

const redactor = createRedactor(DEFAULT_PATTERNS);

export interface Prepared extends AiContext {
  /** Possible leaks in the text as it would be sent. */
  leaks: LeakFinding[];
}

/** The runbook (or its code cells `cells`, parsed indexes) as it would be sent, and its leak check. */
export async function prepareContext(text: string, title: string, cells?: number[]): Promise<Prepared> {
  const ctx = buildAiContext(
    text,
    { redact: redactor.redact, maxOutputLines: 80, maxChars: 60_000, pseudonymize: true, title, ...(cells ? { cells } : {}) },
    await currentMap(),
  );
  map = ctx.map;
  void setJson(MAP_KEY, ctx.map).catch(() => undefined);
  return { ...ctx, leaks: scanForLeaks(ctx.text) };
}

/** Copy for AI: the context with the header that tells an assistant how to answer. */
export const copyText = (ctx: AiContext): string => `${DEFAULT_COPY_HEADER}\n\n${ctx.text}\n`;

/** The device's alias map (to map answers and pasted text back to real names). */
export const pseudonymMap = (): Promise<PseudonymMap> => currentMap();

/** Tests. */
export function resetPseudonyms(): void {
  map = undefined;
}

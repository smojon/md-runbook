/**
 * The launch form's Start, checked (launch.ts): no vscode import, so it is unit-tested. The same
 * rules as the app's launch form (apps/mobile runbooks/launch.ts).
 */

import type { LaunchModel } from './launch';

type Sent = { params: Record<string, unknown>; inputs: Record<string, unknown> };

function sentValues(sent: unknown): Sent {
  const s = (sent ?? {}) as { params?: unknown; inputs?: unknown };
  const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  return { params: record(s.params), inputs: record(s.inputs) };
}

/**
 * The parameters Start would leave with neither a value nor a default (the run would stop at
 * them): the value sent, else the one the form showed.
 */
export function missingParams(params: LaunchModel['params'], sent: unknown): string[] {
  const s = sentValues(sent).params;
  return params.filter((p) => {
    const v = s[p.name];
    const value = typeof v === 'string' ? v : (p.value ?? '');
    return value === '' && p.default === undefined;
  }).map((p) => p.name);
}

/** The error for `missingParams`, as the app says it: "Type a value for TAG: it has no default." */
export function missingText(names: readonly string[]): string {
  return `Type a value for ${names.join(', ')}: ${names.length === 1 ? 'it has' : 'they have'} no default.`;
}

/**
 * The values the form sent at Start, checked against the form: known names only, a choice for a
 * parameter that has choices, a value for one without a default. An empty secret input is not a
 * value (the run asks, or keeps the one this session has). `error` names the field when one is wrong.
 */
export function startValues(m: LaunchModel, sent: unknown): { params: Record<string, string>; inputs: Record<string, string> } | { error: string; field: string } {
  const { params: sentParams, inputs: sentInputs } = sentValues(sent);
  const params: Record<string, string> = {};
  const inputs: Record<string, string> = {};
  for (const p of m.params) {
    const v = sentParams[p.name];
    if (typeof v !== 'string') continue;
    if (p.choices && !p.choices.includes(v)) return { error: `${p.name} must be one of: ${p.choices.join(', ')}`, field: `param:${p.name}` };
    params[p.name] = v;
  }
  const missing = missingParams(m.params, sent);
  if (missing.length) return { error: missingText(missing), field: `param:${missing[0]}` };
  for (const i of m.inputs) {
    const v = sentInputs[i.name];
    if (typeof v !== 'string' || (i.secret && v === '')) continue;
    inputs[i.name] = v;
  }
  return { params, inputs };
}

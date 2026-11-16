/**
 * Where the runbook last ran, from its output markers, as VS Code's recorded context
 * (mdRunbook.output.recordContext): the newest run's `context=` (the host's Kubernetes context,
 * recorded by the app when Hosts & settings → Record where each step ran is on), else its
 * `kube-context=`, and its `on=` (the account: user@host). The launch form and the Steps header
 * show it as Last run in. Pure: read from the text, so it survives a restart and comes from VS Code too.
 */
import { isCodeMeta, parse } from '@md-runbook/core';

export interface RunContext {
  /** `prod-eu`: the Kubernetes context seen when the step ran. */
  context?: string;
  /** `deploy@web-1.example.net`: the account it ran as. */
  on?: string;
}

/** The newest run's recorded context, if a run recorded one. */
export function lastRunContext(text: string): RunContext | undefined {
  let best: { at: number; ctx: RunContext } | undefined;
  for (const c of parse(text).cells) {
    if (c.kind !== 'code' || !isCodeMeta(c.meta)) continue;
    const a = c.output?.attrs;
    if (!a) continue;
    const context = a.context ?? a['kube-context'];
    const ctx: RunContext = { ...(context ? { context } : {}), ...(a.on ? { on: a.on } : {}) };
    if (ctx.context === undefined && ctx.on === undefined) continue;
    const at = Date.parse(a.ran ?? a.ended ?? '');
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { at, ctx };
  }
  return best?.ctx;
}

/** The context as one line: `prod-eu · deploy@web-1`. */
export function runContextText(c: RunContext): string {
  return [c.context, c.on].filter((s): s is string => s !== undefined).join(' · ');
}

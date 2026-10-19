/**
 * Durations of the extension's own work when a runbook opens, recorded only under the integration
 * tests (MD_RUNBOOK_TEST), which read them from the same process (test/integration/probe.ts).
 */

interface Timing {
  what: string;
  file: string;
  at: number;
  ms: number;
}

const enabled = !!process.env.MD_RUNBOOK_TEST;

export function timed<T>(what: string, file: string, fn: () => T): T {
  if (!enabled) return fn();
  const at = Date.now();
  try {
    return fn();
  } finally {
    const g = globalThis as { __mdRunbookTimings?: Timing[] };
    (g.__mdRunbookTimings ??= []).push({ what, file, at, ms: Date.now() - at });
  }
}

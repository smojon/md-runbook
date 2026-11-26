/**
 * Which runbook opened each run copy of a runbook call (calls.ts), so the surfaces that follow the
 * runbook in front (the status bar item, the Steps view) can show a question a call it runs asks.
 * No imports: currentRunbook.ts and calls.ts both use it.
 */

const callerOf = new Map<string, string>();

/** The call copy `copy` was opened by a call cell of `caller` (both notebook URIs as strings). */
export function setCaller(copy: string, caller: string): void {
  callerOf.set(copy, caller);
}

/** `uri` is a run copy that `ancestor` runs: called by it, or by a copy it runs, and so on. */
export function runsUnder(uri: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = callerOf.get(uri); at !== undefined && !seen.has(at); at = callerOf.get(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

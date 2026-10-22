/**
 * Run All as Copy opens the copy with `autorun=1` to run it at once. Every route can be opened
 * from a link (mdrunbook://runbook/ID?autorun=1, or the web app's address), so the parameter only
 * counts when this app asked for it: the request is kept here, in memory.
 */
const asked = new Set<string>();

export function askAutorun(id: string): void {
  asked.add(id);
}

export function autorunAsked(id: string): boolean {
  return asked.has(id);
}

export function autorunDone(id: string): void {
  asked.delete(id);
}

/**
 * The web: the browser's Notification API, while the tab is hidden. A hidden tab keeps running
 * (its timers slowed down), so there is no "paused" notification here. Browsers that only show
 * notifications from a service worker (Chrome on Android) or have none count as unsupported.
 */
import type { NotificationText, Permission } from './platform';

export type { NotificationText, Permission } from './platform';

const N: typeof Notification | undefined =
  typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext !== false ? window.Notification : undefined;

let broken = false;
export const supported = N !== undefined;
export const canSchedule = false;

export async function prepare(): Promise<void> {}

const asPermission = (p: NotificationPermission): Permission => (p === 'default' ? 'undetermined' : p);

export async function permission(): Promise<Permission> {
  return N && !broken ? asPermission(N.permission) : 'denied';
}

export async function requestPermission(): Promise<Permission> {
  if (!N || broken) return 'denied';
  try {
    return asPermission(await N.requestPermission());
  } catch {
    return 'denied';
  }
}

const shown = new Map<string, Notification>();
const listeners = new Set<(data: Record<string, unknown>, id: string) => void>();
let next = 1;

export async function show(n: NotificationText): Promise<string | undefined> {
  if (!N || broken) return undefined;
  try {
    // One per runbook (tag): a newer one replaces the one before.
    const note = new N(n.title, { body: n.body, data: n.data, tag: String(n.data.runbookId ?? '') });
    const id = String(next++);
    shown.set(id, note);
    note.onclick = () => {
      window.focus();
      note.close();
      shown.delete(id);
      listeners.forEach((l) => l(n.data, id));
    };
    note.onclose = () => shown.delete(id);
    return id;
  } catch {
    // "Illegal constructor": only a service worker can show one in this browser.
    broken = true;
    return undefined;
  }
}

export async function schedule(): Promise<string | undefined> {
  return undefined;
}

export async function remove(id: string): Promise<void> {
  shown.get(id)?.close();
  shown.delete(id);
}

export function onTap(listener: (data: Record<string, unknown>, id: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

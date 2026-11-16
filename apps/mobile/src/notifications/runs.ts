/**
 * A run that ends or waits while you are away: a notification in the run bar's words, only while
 * the app is not on screen (the web: the tab is hidden), only when you said yes (the first Run
 * all offers it) and the system allows it.
 *
 * What happens to a run in the background: iOS suspends the app about half a minute after it
 * leaves the screen (the background time runCell asks for), and Android 14+ freezes it about ten
 * seconds after it is cached, closing its TCP connections; nothing runs then, so no result would
 * come. So when the app goes to the background during a run, a "paused" notification is
 * scheduled for about when that happens: a run that ends or waits before then takes it back and
 * says how it ended; one that doesn't, can't, and the system shows it.
 */
import { AppState, Platform } from 'react-native';
import { notifyRuns, setNotifyRuns } from '../settings/store';
import { t } from '../i18n';
import * as platform from './platform';

/** What a tap on the notification opens: the runbook, at this cell. */
export interface RunTarget {
  runbookId: string;
  cellIndex?: number;
}

/**
 * When the "paused" notification shows, after the app leaves the screen during a run: iOS ends
 * its background time after about 30 s; Android 14+ freezes a cached app 10 s after it is cached.
 */
export const PAUSED_AFTER_SECONDS = Platform.OS === 'ios' ? 30 : 12;

/** Notifications can be offered here (not on a web browser without them). */
export const notificationsSupported = (): boolean => platform.supported;

const away = (): boolean => AppState.currentState !== 'active';

/** The "paused" notification scheduled per runbook (its id, once the system gave one). */
const paused = new Map<string, Promise<string | undefined>>();

function dataOf(target: RunTarget): Record<string, string | number> {
  return { runbookId: target.runbookId, ...(target.cellIndex !== undefined ? { cellIndex: target.cellIndex } : {}) };
}

async function allowed(): Promise<boolean> {
  return notifyRuns() === true && (await platform.permission()) === 'granted';
}

/** Takes back the runbook's "paused" notification (scheduled or shown). */
export async function cancelPaused(runbookId: string): Promise<void> {
  const id = paused.get(runbookId);
  if (!id) return;
  paused.delete(runbookId);
  const shown = await id;
  if (shown) await platform.remove(shown);
}

/**
 * The run ended (done, failed, stopped) or waits for an answer. `title` and `body` read as one
 * line: "Deploy checkout" + "Step 4 of 6 failed — Push image". Nothing while the app is on screen.
 */
export async function notifyRun(target: RunTarget, title: string, body: string): Promise<void> {
  if (!away()) return;
  await cancelPaused(target.runbookId);
  if (!(await allowed())) return;
  await platform.show({ title, body, data: dataOf(target) });
}

/**
 * Notify Me When It Starts: a step a reader marked starts. A notification while the app is away
 * (the "paused" one stays: the run still pauses with the app); on screen the run bar says it.
 */
export async function notifyStepStarted(target: RunTarget, title: string, body: string): Promise<void> {
  if (!away() || !(await allowed())) return;
  await platform.show({ title, body, data: dataOf(target) });
}

/** The app left the screen during a run: the "paused" notification, unless the run ends or waits first. */
export async function runWentAway(target: RunTarget, runbookName: string): Promise<void> {
  if (!platform.canSchedule || paused.has(target.runbookId) || !(await allowed()) || !away()) return;
  paused.set(
    target.runbookId,
    platform.schedule({ title: t.notifyPaused(runbookName), body: t.notifyPausedBody, data: dataOf(target) }, PAUSED_AFTER_SECONDS),
  );
}

/** Asked at the first Run all: whether to show the offer (and, when the system already refused, never again). */
export async function shouldOffer(): Promise<boolean> {
  if (notifyRuns() !== undefined || !platform.supported) return false;
  if ((await platform.permission()) === 'denied') {
    setNotifyRuns(false);
    return false;
  }
  return true;
}

/** Notify me (the offer, or the setting turned on): asks the system if needed; true when allowed. */
export async function turnOnNotifications(): Promise<boolean> {
  const now = await platform.permission();
  const p = now === 'undetermined' ? await platform.requestPermission() : now;
  setNotifyRuns(p === 'granted');
  return p === 'granted';
}

/** Not now: not offered again (the setting still turns them on). */
export function declineNotifications(): void {
  setNotifyRuns(false);
}

/** Tests. */
export function resetRunNotifications(): void {
  paused.clear();
}

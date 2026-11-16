/**
 * iOS and Android: local notifications through expo-notifications (no push: nothing leaves the
 * device). Shown only while the app is in the background: the handler hides them in the
 * foreground, where the run bar says the same. Android posts them on the "Runs" channel, made
 * before the permission is asked (Android 13 shows its prompt only once a channel exists).
 * The web has platform.web.ts.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { t } from '../i18n';

export type Permission = 'granted' | 'denied' | 'undetermined';

export interface NotificationText {
  title: string;
  body: string;
  data: Record<string, string | number>;
}

const CHANNEL = 'runs';

/** Local notifications can be shown here. */
export const supported = true;
/** A notification can be scheduled to show later even if the app is suspended by then (the "paused" one). */
export const canSchedule = true;

// In the foreground the run bar says it all: nothing shown (one scheduled earlier, such as the
// "paused" one of a run before the app restarted, included). Set as the app starts. An alert's
// push (alertPush.ts) shows, sound included: nothing on screen says it otherwise.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const alert = n.request.content.data?.kind === 'alert';
    return { shouldShowBanner: alert, shouldShowList: alert, shouldPlaySound: alert, shouldSetBadge: false };
  },
});

let prepared: Promise<void> | undefined;

/** The Android channel, once, before the first permission request or notification. */
export function prepare(): Promise<void> {
  return (prepared ??= (async () => {
    if (Platform.OS === 'android')
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: t.notifyChannel,
        description: t.notifyChannelHelp,
        // A heads-up banner: you are away and the run needs you. (The import plugin can't read this compiled enum.)
        // eslint-disable-next-line import/namespace
        importance: Notifications.AndroidImportance.HIGH,
      });
  })().catch(() => undefined));
}

/** Denied: the system won't ask again (iOS after a no; Android after two); else it can still be asked. */
const asPermission = (p: Notifications.NotificationPermissionsStatus): Permission =>
  p.granted ? 'granted' : p.canAskAgain === false ? 'denied' : 'undetermined';

export async function permission(): Promise<Permission> {
  try {
    return asPermission(await Notifications.getPermissionsAsync());
  } catch {
    return 'denied';
  }
}

export async function requestPermission(): Promise<Permission> {
  await prepare();
  try {
    return asPermission(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
  } catch {
    return 'denied';
  }
}

/** Shows it now; resolves its id (undefined when the system refused it). */
export async function show(n: NotificationText): Promise<string | undefined> {
  await prepare();
  return Notifications.scheduleNotificationAsync({
    content: { title: n.title, body: n.body, data: n.data },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
  }).catch(() => undefined);
}

/** Shows it in `seconds`, whether or not the app still runs then. */
export async function schedule(n: NotificationText, seconds: number): Promise<string | undefined> {
  await prepare();
  return Notifications.scheduleNotificationAsync({
    content: { title: n.title, body: n.body, data: n.data },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds, channelId: CHANNEL },
  }).catch(() => undefined);
}

/** Not shown after all: cancelled if still scheduled, taken away if shown. */
export async function remove(id: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  await Notifications.dismissNotificationAsync(id).catch(() => undefined);
}

/** Taps on a notification (its data), including the one that started the app. */
export function onTap(listener: (data: Record<string, unknown>, id: string) => void): () => void {
  const seen = new Set<string>();
  const handle = (r: Notifications.NotificationResponse | null): void => {
    if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = r.notification.request.identifier;
    if (seen.has(id)) return;
    seen.add(id);
    listener(r.notification.request.content.data ?? {}, id);
  };
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  // The tap that started the app (it may have come before the listener).
  try {
    handle(Notifications.getLastNotificationResponse());
    Notifications.clearLastNotificationResponse();
  } catch {
    // none
  }
  return () => sub.remove();
}

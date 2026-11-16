/**
 * iOS and Android: the phone's native push token (an APNs device token, an FCM registration
 * token), which the team library server sends alerts to directly; not Expo's push service. And
 * the Android channel alerts show on. The web has pushToken.web.ts (no pushes there).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { t } from '../i18n';

/** The channel the library server names in its pushes (apps/library-server/src/push.ts). */
export const ALERT_CHANNEL = 'alerts';

export async function devicePushToken(): Promise<string> {
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== 'string' || token.data === '') throw new Error(t.alertPushNoToken);
  return token.data;
}

/** The Android channel for alerts, before the first one comes (made again: it only updates). */
export async function prepareAlertChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
    name: t.alertPushChannel,
    description: t.alertPushChannelHelp,
    // A heads-up banner with sound: on-call is paged. (The import plugin can't read this compiled enum.)
    // eslint-disable-next-line import/namespace
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => undefined);
}

/** A new push token (the provider rolled it): `listener` registers it again. */
export function onPushToken(listener: (token: string) => void): () => void {
  const sub = Notifications.addPushTokenListener((token) => {
    if (typeof token.data === 'string' && token.data !== '') listener(token.data);
  });
  return () => sub.remove();
}

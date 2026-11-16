/** The web: no pushes (alertPush.ts never asks here; Alerts on this phone is not shown). */
import { t } from '../i18n';

export const ALERT_CHANNEL = 'alerts';

export async function devicePushToken(): Promise<string> {
  throw new Error(t.alertPushNoToken);
}

export async function prepareAlertChannel(): Promise<void> {}

export function onPushToken(): () => void {
  return () => undefined;
}

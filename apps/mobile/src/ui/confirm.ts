/**
 * Ask before something that can't be undone: the platform's own dialog (the browser's confirm on
 * the web), a short title and its points under it.
 */
import { Alert, Platform } from 'react-native';
import { t } from '../i18n';

export function confirmThen(title: string, points: readonly string[], ok: string, then: () => void): void {
  const body = points.map((p) => `• ${p}`).join('\n');
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(body ? `${title}\n\n${body}` : title)) then();
    return;
  }
  Alert.alert(title, body || undefined, [
    { text: t.cancel, style: 'cancel' },
    { text: ok, style: 'destructive', onPress: then },
  ]);
}

/**
 * The app icon's long-press menu, kept in step with the app: Scan a code, then the pinned runbooks
 * (four items in all, as both systems show). A quick action that started the app on iOS is opened
 * once the router is up (Android delivers it as an mdrunbook:// link).
 */
import { router, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';
import { AppShortcuts } from '../../modules/app-shortcuts';
import { t } from '../i18n';
import { usePins } from '../runbooks/pins';
import { useRunbooks } from '../runbooks/store';

export function useAppShortcuts(): void {
  const pins = usePins();
  const runbooks = useRunbooks();
  useEffect(() => {
    if (!AppShortcuts) return;
    const pinned = pins.flatMap((id) => runbooks.filter((r) => r.id === id)).slice(0, 3);
    AppShortcuts.setShortcuts([
      { id: 'scan', title: t.scanCode, path: '/scan', icon: 'qrcode.viewfinder' },
      ...pinned.map((r) => ({ id: `runbook-${r.id}`, title: r.title, path: `/runbook/${r.id}`, icon: 'doc.text' })),
    ]);
  }, [pins, runbooks]);
  // Once the navigator is mounted (navigating before that is lost, with a warning).
  const ready = useRootNavigationState()?.key !== undefined;
  useEffect(() => {
    if (!ready) return;
    const path = AppShortcuts?.takeLaunchPath();
    if (path === '/scan') router.push('/scan');
    else if (path?.startsWith('/runbook/')) router.push({ pathname: '/runbook/[id]', params: { id: path.slice('/runbook/'.length) } });
  }, [ready]);
}

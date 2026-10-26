/**
 * The app icon's long-press menu (iOS quick actions, Android app shortcuts): Scan a code and the
 * pinned runbooks, each a route of the app. Null on the web and in Jest.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface AppShortcut {
  id: string;
  title: string;
  /** A route of the app: `/scan`, `/runbook/ID`. */
  path: string;
  /** iOS: an SF Symbol name. */
  icon?: string;
}

export interface AppShortcutsModule {
  setShortcuts(items: AppShortcut[]): void;
  /** iOS: the route of the quick action that started the app, once (Android opens it as a link). */
  takeLaunchPath(): string | null;
}

export const AppShortcuts = requireOptionalNativeModule<AppShortcutsModule>('AppShortcuts');

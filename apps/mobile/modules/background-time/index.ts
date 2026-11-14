/**
 * iOS: background time while a cell runs (about half a minute), so switching to another app for a
 * moment doesn't cut the cell's connection. Null on Android (no such API: Android 14+ freezes a
 * cached app about ten seconds after it leaves the screen and closes its TCP connections; see
 * src/notifications/runs.ts), on the web and in Jest.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface BackgroundTimeModule {
  /** Starts a background task; returns its id for end(). */
  begin(name: string): number;
  end(id: number): void;
}

export const BackgroundTime = requireOptionalNativeModule<BackgroundTimeModule>('BackgroundTime');

/** Run `work` with background time on iOS (and as is elsewhere). */
export async function withBackgroundTime<T>(name: string, work: () => Promise<T>): Promise<T> {
  const id = BackgroundTime?.begin(name);
  try {
    return await work();
  } finally {
    if (id !== undefined) BackgroundTime?.end(id);
  }
}

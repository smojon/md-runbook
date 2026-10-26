/**
 * iOS: background time while a cell runs (about half a minute), so switching to another app for a
 * moment doesn't cut the cell's connection. Null on Android (it keeps a backgrounded app's
 * connections), on the web and in Jest.
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

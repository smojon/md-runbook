/**
 * iOS: open a runbook where it is (iCloud Drive, On My iPhone, a Files provider) and save it
 * back there later, also after the app restarts. Expo's pickers hand over a copy; this module
 * opens the file in place and keeps a security-scoped bookmark to it. Null on Android (Expo's
 * file system keeps a lasting grant there), on the web and in Jest.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface PickedDocument {
  name: string;
  text: string;
  /** Base64 bookmark: reopens the same file later (it follows renames and moves). */
  bookmark: string;
}

export interface DocumentAccessModule {
  /** The system picker for one Markdown or text file; null when the user cancels. */
  pick(): Promise<PickedDocument | null>;
  /** The file's text now, and a fresh bookmark when iOS says the old one is stale. */
  read(bookmark: string): Promise<{ text: string; bookmark?: string }>;
  /** Replace the file's text (coordinated with other writers, atomically). */
  write(bookmark: string, text: string): Promise<void>;
}

export const DocumentAccess = requireOptionalNativeModule<DocumentAccessModule>('DocumentAccess');

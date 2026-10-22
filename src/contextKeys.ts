/** Our when-clause context keys, also kept here so the toolbar lists can read them back. */

import * as vscode from 'vscode';

const values = new Map<string, unknown>();

export function setContext(key: string, value: unknown): void {
  values.set(key, value);
  void vscode.commands.executeCommand('setContext', key, value);
}

export const contextValue = (key: string): unknown => values.get(key);

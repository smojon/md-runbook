/**
 * List settings that protect what leaves this machine (redaction patterns, the terms and domains
 * pseudonymized for AI): a workspace's `.vscode/settings.json` may add items, but not drop yours.
 * VS Code's `get()` returns the most specific level only, so a workspace setting `[]` would
 * replace the user's list; these read every level (`inspect()`) and join them.
 */

/** The levels of a setting, as `WorkspaceConfiguration.inspect()` gives them. */
export interface SettingLevels {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** The user's items, then the workspace's, then the folder's; each once (equal JSON). */
export function joinedLevels<T>(levels: SettingLevels | undefined, keep: (v: unknown) => v is T): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const level of [levels?.globalValue, levels?.workspaceValue, levels?.workspaceFolderValue]) {
    if (!Array.isArray(level)) continue;
    for (const v of level) {
      if (!keep(v)) continue;
      const key = JSON.stringify(v);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

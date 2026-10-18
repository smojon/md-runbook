/**
 * Registry of Run All as Copy copies made in another folder (`output.copyFolder`): copy URI ->
 * working directory of the original runbook. `workingDirectory()` consults it so every relative
 * path of a copy (`cwd=`, `envFile=`, context, policy) resolves against the original's folder.
 * Kept free of other imports so both controller.ts and history.ts can use it without a cycle.
 */

const origins = new Map<string, string>();

/** Something with a stable string form (a vscode.Uri). */
interface UriLike {
  toString(): string;
}

/** Remember that `copy` belongs to a runbook whose cells run in `originDir`. */
export function setCopyOrigin(copy: UriLike, originDir: string): void {
  origins.set(copy.toString(), originDir);
}

/** The original runbook's working directory for a copy made elsewhere, else undefined. */
export function copyOrigin(uri: UriLike): string | undefined {
  return origins.get(uri.toString());
}

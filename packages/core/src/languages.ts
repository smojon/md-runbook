/** Mapping between fence languages and VS Code language ids. */

/** Fence languages that become runnable code cells. */
export const RUNNABLE_FENCE_LANGS: ReadonlySet<string> = new Set(['sh', 'bash', 'pwsh', 'powershell', 'cmd']);

const FENCE_TO_LANGUAGE_ID: Readonly<Record<string, string>> = {
  sh: 'shellscript',
  bash: 'shellscript',
  pwsh: 'powershell',
  powershell: 'powershell',
  cmd: 'bat',
};

/** Fence word written for a cell whose language was changed in the editor. */
const LANGUAGE_ID_TO_FENCE: Readonly<Record<string, string>> = {
  shellscript: 'bash',
  powershell: 'pwsh',
  bat: 'cmd',
};

export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.keys(LANGUAGE_ID_TO_FENCE);

export function isRunnableFenceLang(lang: string): boolean {
  return RUNNABLE_FENCE_LANGS.has(lang);
}

export function languageIdForFence(lang: string): string {
  return FENCE_TO_LANGUAGE_ID[lang] ?? lang;
}

export function fenceForLanguageId(languageId: string): string {
  return LANGUAGE_ID_TO_FENCE[languageId] ?? languageId;
}

/**
 * All user-visible text comes from here, so translations can be added later without touching the
 * screens (ESLint's react/jsx-no-literals rejects text written in a screen). English only for
 * now; a second language would add a catalog per language and pick one with expo-localization.
 */
const en = {
  appTitle: 'md-runbook',
  commands: (n: number) => (n === 1 ? '1 command' : `${n} commands`),
  coreOk: 'Core OK',
  coreFailed: (why: string) => `Core check failed: ${why}`,
  notFound: 'Runbook not found',
  outputExit: (exit: string) => `Output · exit ${exit}`,
} as const;

export type Strings = typeof en;
export const t: Strings = en;

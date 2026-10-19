/**
 * All user-visible text goes through `t()`, so translations can be added later without touching
 * the screens (a lesson from the user's other app). English only for now.
 */
const en = {
  appTitle: 'md-runbook',
  commands: (n: number) => (n === 1 ? '1 command' : `${n} commands`),
  coreOk: 'Core OK',
  coreFailed: (why: string) => `Core check failed: ${why}`,
  notFound: 'Runbook not found',
  output: 'Output',
} as const;

export type Strings = typeof en;
export const t: Strings = en;

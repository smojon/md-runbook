/**
 * The front matter keys that change how every cell of a runbook runs. A version 1 signature covers
 * the bash blocks only, not the front matter: a runbook signed that way that sets any of these
 * doesn't count as signed (the command line's signed runs, VS Code and app links). Security
 * review, 2026-11-16.
 */
import type { FrontMatter } from './secrets';

/** Which of them the front matter sets, as `env:`, `cwd:`, …, in this order. */
export function runFrontMatterKeys(fm: FrontMatter | undefined): string[] {
  if (!fm) return [];
  return (
    [
      ['env', fm.env !== undefined && Object.keys(fm.env).length > 0],
      ['cwd', fm.cwd !== undefined],
      ['shell', fm.shell !== undefined],
      ['mode', fm.mode !== undefined],
      ['kube-context', fm.kubeContext !== undefined],
      ['kube-context-mode', fm.kubeContextMode !== undefined],
      ['timeout', fm.timeoutSeconds !== undefined],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([k]) => `${k}:`);
}

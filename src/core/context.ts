/** Run a context command (e.g. `kubectl config current-context`) and keep its first line. */

import { exec } from 'node:child_process';

export const CONTEXT_UNKNOWN = 'unknown';

/** First non-empty line, trimmed; '' if there is none. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/** Runs through the platform shell (cmd.exe on Windows, /bin/sh elsewhere). Never rejects. */
export function runContextCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const v = err ? '' : firstLine(stdout);
      resolve(v === '' ? CONTEXT_UNKNOWN : v);
    });
  });
}

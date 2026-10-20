/** Open timing: how long a runbook takes to show its cells (the slow-open hint is based on it). */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, writeFile } from './suite';

const say = (s: string): string => (isWin ? `Write-Output '${s}'` : `echo ${s}`);

export const tests: Test[] = [
  {
    name: 'open timing: an opened runbook reports the time until its cells showed',
    fn: async () => {
      const uri = writeFile('open-timing.md', `# Timing\n\nSome text.\n\n\`\`\`${LANG}\n${say('one')}\n\`\`\`\n`);
      try {
        const started = Date.now();
        await openRunbook(uri);
        // Visible ranges arrive once the cell list is attached, which can be just after the open settles.
        const lastOpenMs = (): Thenable<number | undefined> => vscode.commands.executeCommand<number | undefined>('mdRunbook._lastOpenMs');
        let ms = await lastOpenMs();
        for (const end = Date.now() + 30_000; ms === undefined && Date.now() < end; ms = await lastOpenMs()) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(typeof ms, 'number', 'no open time: the editor showed cells before it was seen, or never reported visible ranges');
        assert.ok(ms! >= 0 && ms! <= Date.now() - started + 1000, `open time ${ms} ms outside 0..${Date.now() - started} ms`);
      } finally {
        await closeAll();
      }
    },
  },
];

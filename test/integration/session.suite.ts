/** Persistent session mode end to end: state set in one cell is visible in the next. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, runCells, setConfig, step, waitFor, waitForRun, writeFile } from './suite';

export const tests: Test[] = [
  {
    name: `session mode keeps environment variables between ${LANG} cells`,
    fn: async () => {
      await setConfig('execution.mode', 'session');
      try {
        const set = isWin ? "$env:FOO = 'bar'" : 'export FOO=bar';
        const get = isWin ? 'Write-Output "FOO=$env:FOO"' : 'echo "FOO=$FOO"';
        const uri = writeFile('session.md', `# Session\n\n\`\`\`${LANG}\n${set}\n\`\`\`\n\n\`\`\`${LANG}\n${get}\n\`\`\`\n`);
        const editor = await openRunbook(uri);
        const [first, second] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        await runCells(editor, 1, 3);
        assert.equal(await waitForRun(first), true, outputText(first));
        assert.equal(await waitForRun(second), true, outputText(second));
        assert.match(outputText(second), /FOO=bar/);
        assert.match(outputText(second), /session/, 'status line names the session');
        assert.doesNotMatch(outputText(first) + outputText(second), /__MDRB_/);

        // Stopping the session forgets the state.
        const stopped = await step('stop session', vscode.commands.executeCommand<string[]>('mdRunbook.stopSession', uri));
        assert.deepEqual(stopped, [isWin ? 'pwsh' : 'bash'], 'stop should find the running session');
        await runCells(editor, 2, 3);
        await waitFor('re-run in a new session', () => /FOO=\r?\n/.test(outputText(second)) && /exit code 0/.test(outputText(second))).catch((e: Error) => {
          throw new Error(`${e.message}; output: ${JSON.stringify(outputText(second))}`);
        });
      } finally {
        await setConfig('execution.mode', undefined);
        await closeAll();
      }
    },
  },
];

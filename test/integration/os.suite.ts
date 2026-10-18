/** os= alternatives: only the block for this OS runs; the others keep their output; one step. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { Test, closeAll, isWin, openRunbook, outputText, read, runCells, touchAndSave, waitForRun, writeFile } from './suite';

type Progress = { total: number; done: number; pending: number };

export const tests: Test[] = [
  {
    name: 'os=: Run All runs the alternative for this OS only and counts the group as one step',
    fn: async () => {
      const uri = writeFile(
        'os-alt.md',
        '# OS\n\nWindows:\n\n```pwsh os=windows\nWrite-Output "on-windows"\n```\n\nLinux and macOS:\n\n```bash os=linux,macos\necho on-unix\n```\n\n```' +
          (isWin ? 'pwsh' : 'bash') +
          '\necho after\n```\n',
      );
      try {
        const editor = await openRunbook(uri);
        const cells = editor.notebook.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
        const [win, unix, after] = cells as [vscode.NotebookCell, vscode.NotebookCell, vscode.NotebookCell];
        const [mine, other] = isWin ? [win, unix] : [unix, win];
        await runCells(editor, 0, editor.notebook.cellCount);
        assert.equal(await waitForRun(after), true, outputText(after));
        assert.equal(await waitForRun(mine), true, outputText(mine));
        assert.match(outputText(mine), isWin ? /on-windows/ : /on-unix/);
        assert.equal(other.outputs.length, 0, 'the other OS block is not run and gets no output');
        const p = await vscode.commands.executeCommand<Progress>('mdRunbook._progress', uri);
        assert.deepEqual([p?.total, p?.done, p?.pending], [2, 2, 0]);

        // Running the other OS's block on its own does nothing either.
        await runCells(editor, other.index, other.index + 1);
        await new Promise((r) => setTimeout(r, 1000));
        assert.equal(other.outputs.length, 0);
        await touchAndSave(editor.notebook);
        assert.equal((read(uri).match(/md-runbook:output start/g) ?? []).length, 2);
      } finally {
        await closeAll();
      }
    },
  },
];

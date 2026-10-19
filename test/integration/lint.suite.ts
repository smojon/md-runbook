/** Problem markers: the lint checks show on the cells of an open runbook and go when fixed. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { Test, closeAll, openRunbook, writeFile } from './suite';

export const tests: Test[] = [
  {
    name: 'lint: problems show on the cell that has them and go away when fixed',
    fn: async () => {
      const uri = writeFile('lint.md', '# Lint\n\n```bash retires=3\necho a\necho ${out:POD}\n```\n');
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        const markers = (): Thenable<string[]> => vscode.commands.executeCommand<string[]>('mdRunbook._diagnostics', cell.document.uri);
        let found: string[] = [];
        const end = Date.now() + 15_000;
        while (!(found = await markers()).some((m) => /\$\{out:POD\} is not captured/.test(m))) {
          if (Date.now() > end) throw new Error(`no lint markers; got ${JSON.stringify(found)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(found.some((m) => /^cell options: unknown cell option "retires"/.test(m)), JSON.stringify(found));

        // Fix the cell: the ${out:} marker goes (the unknown option stays: it is in the fence).
        const edit = new vscode.WorkspaceEdit();
        edit.replace(cell.document.uri, new vscode.Range(1, 0, 1, cell.document.lineAt(1).text.length), 'echo b');
        await vscode.workspace.applyEdit(edit);
        const end2 = Date.now() + 15_000;
        while ((found = await markers()).some((m) => /\$\{out:POD\}/.test(m))) {
          if (Date.now() > end2) throw new Error(`marker still there: ${JSON.stringify(found)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await closeAll();
      }
    },
  },
];

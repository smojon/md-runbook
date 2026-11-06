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
  {
    name: 'lint: a misspelled option has a Quick Fix that renames it on the fence',
    fn: async () => {
      const uri = writeFile('lint-fix.md', '# Fix\n\n```bash retires=3 name="retires"\necho a\n```\n');
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        const markers = (): Thenable<string[]> => vscode.commands.executeCommand<string[]>('mdRunbook._diagnostics', cell.document.uri);
        let found: string[] = [];
        const end = Date.now() + 15_000;
        while (!(found = await markers()).some((m) => /did you mean "retry"\?/.test(m))) {
          if (Date.now() > end) throw new Error(`no typo marker; got ${JSON.stringify(found)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', cell.document.uri, new vscode.Range(0, 0, 0, 1), vscode.CodeActionKind.QuickFix.value);
        const fix = actions.find((a) => a.title === 'Change "retires" to "retry"');
        assert.ok(fix?.command, JSON.stringify(actions.map((a) => a.title)));
        // Called from elsewhere (a command link), it renames nothing but a typo.
        assert.equal(await vscode.commands.executeCommand(fix.command.command, editor.notebook.uri.toString(), 1, 'name', 'x'), false);
        assert.ok(await vscode.commands.executeCommand(fix.command.command, ...(fix.command.arguments ?? [])));
        const info = (editor.notebook.cellAt(1).metadata as { mdRunbook?: { info?: string } }).mdRunbook?.info;
        assert.equal(info, 'bash retry=3 name="retires"', 'only the option is renamed, not the value');
        const end2 = Date.now() + 15_000;
        while ((found = await markers()).some((m) => /retires/.test(m))) {
          if (Date.now() > end2) throw new Error(`marker still there: ${JSON.stringify(found)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await closeAll();
      }
    },
  },
  {
    name: 'lint: the Quick Fix also works in the Markdown text editor',
    fn: async () => {
      const uri = writeFile('lint-fix-text.md', '# Fix\n\n```bash timout=5\necho a\n```\n');
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const fence = new vscode.Range(2, 0, 2, 1);
        let actions: vscode.CodeAction[] = [];
        const end = Date.now() + 15_000;
        while (!(actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, fence, vscode.CodeActionKind.QuickFix.value)).some((a) => a.title === 'Change "timout" to "timeout"')) {
          if (Date.now() > end) throw new Error(`no Quick Fix; got ${JSON.stringify(actions.map((a) => a.title))}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const fix = actions.find((a) => a.title === 'Change "timout" to "timeout"')!;
        assert.ok(fix.edit && (await vscode.workspace.applyEdit(fix.edit)));
        assert.equal(doc.lineAt(2).text, '```bash timeout=5');
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await closeAll();
      }
    },
  },
];

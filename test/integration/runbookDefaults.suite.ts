/** Front matter `cwd:` / `timeout:` and `mdRunbook.output.saveAfterRun`. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, setConfig, waitFor, waitForRun, work, writeFile } from './suite';

const where = isWin ? '"WHERE=$((Get-Location).Path)"' : 'echo "WHERE=$(pwd)"';
const sleep = isWin ? 'Start-Sleep -Seconds 20' : 'sleep 20';

export const tests: Test[] = [
  {
    name: 'front matter cwd: and timeout: are the runbook defaults; cell options still win',
    fn: async () => {
      fs.mkdirSync(path.join(work, 'fm-sub'), { recursive: true });
      const uri = writeFile(
        'fm-defaults.md',
        `---\ncwd: fm-sub\ntimeout: 1\n---\n\n# FM\n\n\`\`\`${LANG}\n${where}\n\`\`\`\n\n\`\`\`${LANG}\n${sleep}\n\`\`\`\n\n\`\`\`${LANG} cwd=.\n${where}\n\`\`\`\n`,
      );
      try {
        const editor = await openRunbook(uri);
        const [a, b, c] = [1, 2, 3].map((i) => editor.notebook.cellAt(i));
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(a!), true, outputText(a!));
        assert.match(outputText(a!), /WHERE=.*fm-sub/);
        await runCells(editor, 2, 3);
        assert.equal(await waitForRun(b!), false);
        assert.match(outputText(b!), /timed out after 1\.0s/);
        await runCells(editor, 3, 4);
        assert.equal(await waitForRun(c!), true, outputText(c!));
        assert.doesNotMatch(outputText(c!), /fm-sub/);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'output.saveAfterRun writes the output to disk without a manual save',
    fn: async () => {
      await setConfig('output.saveAfterRun', true);
      const uri = writeFile('autosave.md', `# Autosave\n\n\`\`\`${LANG}\n${isWin ? 'Write-Output saved-now' : 'echo saved-now'}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(editor.notebook.cellAt(1)), true);
        await waitFor('the file to be saved', () => /saved-now/.test(read(uri)) && !editor.notebook.isDirty);
      } finally {
        await setConfig('output.saveAfterRun', undefined);
        await closeAll();
      }
    },
  },
];

tests.push({
  name: 'Open Sample Runbook opens the bundled sample as an untitled runbook',
  fn: async () => {
    try {
      await vscode.commands.executeCommand('mdRunbook.openSample');
      const nb = await waitFor('the sample to open', () => vscode.window.activeNotebookEditor?.notebook);
      assert.equal(nb.notebookType, 'md-runbook');
      assert.equal(nb.isUntitled, true);
      assert.ok(nb.getCells().some((c) => c.kind === vscode.NotebookCellKind.Code), 'has code cells');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await closeAll();
    }
  },
});

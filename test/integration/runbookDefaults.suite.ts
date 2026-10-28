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
  {
    name: 'output.saveAfterRun default "copies": a run copy is saved after a run, a runbook run in place is not',
    fn: async () => {
      const cell = `\`\`\`${LANG}\n${isWin ? 'Write-Output saved-now' : 'echo saved-now'}\n\`\`\`\n`;
      // Named like a copy of Run All as Copy (`copyFileName`), which is how a reopened copy is recognised.
      const copy = writeFile('copy-default.20261020-120000.md', `# Copy\n\n${cell}`);
      const inPlaceText = `# In place\n\n${cell}`;
      const inPlace = writeFile('inplace-default.md', inPlaceText);
      // The cell's source contains "saved-now" too: only a saved output block proves a save.
      const outputBlock = /md-runbook:output start[\s\S]*saved-now/;
      try {
        let editor = await openRunbook(copy);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(editor.notebook.cellAt(1)), true);
        await waitFor('the copy to be saved', () => outputBlock.test(read(copy)) && !editor.notebook.isDirty);
        await closeAll();

        editor = await openRunbook(inPlace);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(editor.notebook.cellAt(1)), true);
        await new Promise((r) => setTimeout(r, 1500));
        assert.ok(editor.notebook.isDirty, 'the in-place runbook was saved after the run');
        assert.equal(read(inPlace), inPlaceText, 'the in-place runbook was written after the run');
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'output.transcript (on by default) appends each run next to the runbook, unsaved; transcriptFolder is created',
    fn: async () => {
      const text = `# Transcript\n\n## 1. Say it\n\n\`\`\`${LANG} name="Say it"\n${isWin ? 'Write-Output said-live' : 'echo said-live'}\n\`\`\`\n`;
      const uri = writeFile('transcript.runbook.md', text);
      const beside = path.join(work, 'transcript.runbook.transcript.log');
      const inFolder = path.join(work, 'tx-logs', 'transcript.runbook.transcript.log');
      fs.rmSync(beside, { force: true });
      fs.rmSync(path.join(work, 'tx-logs'), { recursive: true, force: true });
      const done = /^===== \S+ · transcript\.runbook\.md · Step 1 · 1\. Say it · Say it\n[\s\S]*^\| said-live\n===== exit=0 · /m;
      try {
        const editor = await openRunbook(uri);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(editor.notebook.cellAt(1)), true);
        await waitFor('the transcript beside the runbook', () => fs.existsSync(beside) && done.test(fs.readFileSync(beside, 'utf8')));
        assert.equal(read(uri), text, 'the runbook itself was not saved');

        await setConfig('output.transcriptFolder', 'tx-logs');
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(editor.notebook.cellAt(1)), true);
        await waitFor('the transcript in the new folder', () => fs.existsSync(inFolder) && done.test(fs.readFileSync(inFolder, 'utf8')));
      } finally {
        await setConfig('output.transcriptFolder', undefined);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
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

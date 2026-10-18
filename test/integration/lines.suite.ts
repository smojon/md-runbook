/** Line runs end to end: Run Lines One by One, Run Line or Selection, Step Through. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, step, touchAndSave, waitFor, waitForRun, work, writeFile } from './suite';

type Progress = { done: number; pending: number; failed: number };
const progress = (uri: vscode.Uri): Thenable<Progress | undefined> => vscode.commands.executeCommand<Progress>('mdRunbook._progress', uri);

const where = isWin ? '"WHERE=$((Get-Location).Path)"' : 'echo "WHERE=$(pwd)"';
const say = (s: string): string => (isWin ? `Write-Output '${s}'` : `echo ${s}`);
const fail = isWin ? 'cmd /c exit 3' : 'false';

export const tests: Test[] = [
  {
    name: 'Run Lines One by One: shows each line, keeps cd between lines, stops at the first failure',
    fn: async () => {
      fs.mkdirSync(path.join(work, 'lines-sub'), { recursive: true });
      const cd = isWin ? 'Set-Location lines-sub' : 'cd lines-sub';
      const src = [`# comment`, cd, where, fail, say('not-reached')].join('\n');
      const uri = writeFile('lines-each.md', `# Lines\n\n\`\`\`${LANG}\n${src}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        void vscode.commands.executeCommand('mdRunbook.runLinesOneByOne', cell);
        assert.equal(await waitForRun(cell), false, outputText(cell));
        const out = outputText(cell);
        assert.match(out, isWin ? /PS> Set-Location lines-sub/ : /\$ cd lines-sub/);
        assert.match(out, /WHERE=.*lines-sub/, 'the cd on line 2 applies to line 3');
        assert.match(out, /line 4 failed/);
        assert.doesNotMatch(out, /not-reached/);
        assert.doesNotMatch(out, /# comment/, 'comment lines are not run');
        assert.match(out, /lines 2-4/);
        assert.equal((await progress(uri))?.failed, 1);
        await touchAndSave(editor.notebook);
        assert.match(read(uri), /md-runbook:output start exit=\d+ .*lines=2-4/);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'Run Line or Selection: runs the line under the cursor, recorded as partial',
    fn: async () => {
      const uri = writeFile('lines-one.md', `# Line\n\n\`\`\`${LANG}\n${say('first')}\n${say('second')}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        const text = await step('show cell editor', vscode.window.showTextDocument(cell.document));
        text.selection = new vscode.Selection(1, 2, 1, 2);
        void vscode.commands.executeCommand('mdRunbook.runLine');
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.match(outputText(cell), /second/);
        assert.doesNotMatch(outputText(cell), /first/);
        assert.match(outputText(cell), /lines 2/);
        // Only part of the step ran: it is not done.
        assert.equal((await progress(uri))?.done, 0);
        assert.equal((await progress(uri))?.pending, 1);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'Step Through: pauses before each line; Stop records the lines that ran',
    fn: async () => {
      const uri = writeFile('lines-step.md', `# Step\n\n\`\`\`${LANG}\n${say('one')}\n${say('two')}\n${say('three')}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        type Paused = { cell: number; index: number };
        const paused = (): Thenable<Paused | undefined> => vscode.commands.executeCommand<Paused>('mdRunbook._stepPaused');
        // waitFor takes a synchronous check, and asking where the run is paused is a command.
        const waitPaused = async (index: number): Promise<Paused> => {
          const end = Date.now() + 30_000;
          for (;;) {
            const p = await paused();
            if (p?.index === index) return p;
            if (Date.now() > end) throw new Error(`timed out waiting for the pause before step ${index + 1}; output: ${JSON.stringify(outputText(cell))}`);
            await new Promise((r) => setTimeout(r, 50));
          }
        };
        void vscode.commands.executeCommand('mdRunbook.stepThroughLines', cell);
        assert.deepEqual(await waitPaused(1), { cell: 1, index: 1 });
        await waitFor('line 1 output', () => /one/.test(outputText(cell)));
        assert.doesNotMatch(outputText(cell), /two/);

        await vscode.commands.executeCommand('mdRunbook.stepNext');
        await waitPaused(2);
        assert.match(outputText(cell), /two/);

        await vscode.commands.executeCommand('mdRunbook.stepStop');
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.doesNotMatch(outputText(cell), /three/);
        assert.match(outputText(cell), /lines 1-2/);
        assert.equal(await paused(), undefined);
      } finally {
        await closeAll();
      }
    },
  },
];

/** Line buttons (hover, or ▶ ☐ inlay hints), Run Checked Lines, and breakpoints in runbook cells. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, selectKernel, setConfig, waitForRun, writeFile } from './suite';

const say = (s: string): string => (isWin ? `Write-Output '${s}'` : `echo ${s}`);
const comment = '# a comment';

type Paused = { cell: number; index: number };
const paused = (): Thenable<Paused | undefined> => vscode.commands.executeCommand<Paused>('mdRunbook._stepPaused');
async function waitPaused(index: number, cell: vscode.NotebookCell): Promise<void> {
  const end = Date.now() + 30_000;
  while ((await paused())?.index !== index) {
    if (Date.now() > end) throw new Error(`no pause before step ${index + 1}; output: ${JSON.stringify(outputText(cell))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The text of the inlay hints of a cell, e.g. ['▶ ☐', '▶ ☑']. */
async function hintLabels(cell: vscode.NotebookCell): Promise<string[]> {
  const doc = cell.document;
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const hints = (await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, range)) ?? [];
  return hints.map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('')).trim());
}

/** The hover text on a line of a cell (markdown, with the command links). */
async function hoverText(cell: vscode.NotebookCell, line: number): Promise<string> {
  const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', cell.document.uri, new vscode.Position(line, 2))) ?? [];
  return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}

const buttonsRunbook = (): string => `# Buttons\n\n\`\`\`${LANG}\n${say('one')}\n${say('two')}\n${say('three')}\n\`\`\`\n\n\`\`\`${LANG}\n${say('alone')}\n\`\`\`\n`;

export const tests: Test[] = [
  {
    name: 'line buttons (hover, the default): ▶ Run line · ☐ Check in a hover, ☑ in the margin, Run N checked lines under the cell',
    fn: async () => {
      const uri = writeFile('hover-buttons.md', `${buttonsRunbook()}\n\`\`\`${LANG}\n${say('delete ${param:ns}')}\n${say('x')}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        const [cell, single] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        const docUri = cell.document.uri.toString();
        assert.deepEqual(await hintLabels(cell), [], 'no inlay hints in hover mode');
        const hover = await hoverText(cell, 1);
        assert.match(hover, /\[▶ Run line 2\]\(command:mdRunbook\.runLineAt\?/);
        assert.match(hover, /\[☐ Check\]\(command:mdRunbook\.toggleLineCheck\?/);
        assert.doesNotMatch(await hoverText(single, 0), /Run line/, 'no buttons in a one-command cell');
        assert.deepEqual(await vscode.commands.executeCommand('mdRunbook._lineStatus', docUri), []);

        // Run / Step from here (not on the last line), breakpoint, copy; no Explain without an AI provider.
        const first = await hoverText(cell, 0);
        assert.match(first, /\[⏩ Run from here \(1-3\)\]\(command:mdRunbook\.runFromLineAt\?/);
        assert.match(first, /\[⏯ Step from here\]\(command:mdRunbook\.stepFromLineAt\?/);
        assert.match(first, /\[● Breakpoint\]\(command:mdRunbook\.toggleBreakpointAt\?/);
        assert.match(first, /\[⧉ Copy\]\(command:mdRunbook\.copyLineAt\?/);
        assert.doesNotMatch(first, /Explain/);
        assert.doesNotMatch(first, /Run until here/, 'nothing before the first line');
        assert.doesNotMatch(await hoverText(cell, 2), /Run from here/, 'nothing after the last line');
        assert.match(await hoverText(cell, 1), /\[⤒ Run until here \(1-2\)\]\(command:mdRunbook\.runToLineAt\?/);

        const bps = (): vscode.Breakpoint[] =>
          vscode.debug.breakpoints.filter((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === docUri);
        await vscode.commands.executeCommand('mdRunbook.toggleBreakpointAt', docUri, 1);
        assert.equal(bps().length, 1);
        assert.match(await hoverText(cell, 1), /● Remove breakpoint/);
        await vscode.commands.executeCommand('mdRunbook.toggleBreakpointAt', docUri, 1);
        assert.equal(bps().length, 0);

        // What a run would ask, and the values of ${…} references; Copy fills them in.
        const risky = editor.notebook.cellAt(3);
        const riskyUri = risky.document.uri.toString();
        assert.match(await hoverText(risky, 0), /⚠ Asks before running: matches ` delete `/);
        assert.match(await hoverText(risky, 0), /` \$\{param:ns\} ` = \*asked when it runs\*/);
        await vscode.commands.executeCommand('mdRunbook._test.setParameters', { ns: 'prod' });
        assert.match(await hoverText(risky, 0), /` \$\{param:ns\} ` = ` prod `/);
        assert.match(await hoverText(risky, 0), /\[⧉ Copy with values\]/);
        assert.equal(await vscode.commands.executeCommand('mdRunbook.copyLineAt', riskyUri, 0), say('delete prod'));
        assert.doesNotMatch(await hoverText(risky, 1), /⚠/, 'a harmless line asks nothing');

        await vscode.commands.executeCommand('mdRunbook.toggleLineCheck', docUri, 0);
        await vscode.commands.executeCommand('mdRunbook.toggleLineCheck', docUri, 2);
        assert.match(await hoverText(cell, 0), /☑ Uncheck/);
        assert.deepEqual(await vscode.commands.executeCommand('mdRunbook._checkMarks', docUri), [0, 2]);
        assert.deepEqual(await vscode.commands.executeCommand('mdRunbook._lineStatus', docUri), ['$(play) Run 2 checked lines']);

        // What the status line item runs (it passes the cell's URI).
        void vscode.commands.executeCommand('mdRunbook.runCheckedLines', docUri);
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.match(outputText(cell), /one[\s\S]*three/);
        assert.doesNotMatch(outputText(cell), /two/);

        // Run until here, from line 2: lines 1 and 2.
        void vscode.commands.executeCommand('mdRunbook.runToLineAt', docUri, 1);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.match(outputText(cell), /one[\s\S]*two/);
        assert.doesNotMatch(outputText(cell), /three/);
        assert.match(outputText(cell), /lines 1-2/);

        await setConfig('lines.buttons', 'off');
        assert.equal(await hoverText(cell, 1), '', 'no hover with lines.buttons off');
        assert.deepEqual(await hintLabels(cell), []);
        assert.deepEqual(await vscode.commands.executeCommand('mdRunbook._checkMarks', docUri), []);
      } finally {
        await setConfig('lines.buttons', undefined);
        await closeAll();
      }
    },
  },
  {
    name: 'line buttons (inline): ▶ ☐ in front of each command; Run Checked Lines runs only the checked ones',
    fn: async () => {
      const uri = writeFile('buttons.md', buttonsRunbook());
      await setConfig('lines.buttons', 'inline');
      try {
        const editor = await openRunbook(uri);
        const [cell, single] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        assert.deepEqual(await hintLabels(cell), ['▶ ☐', '▶ ☐', '▶ ☐']);
        assert.deepEqual(await hintLabels(single), [], 'no buttons in a one-command cell');

        const docUri = cell.document.uri.toString();
        await vscode.commands.executeCommand('mdRunbook.toggleLineCheck', docUri, 0);
        await vscode.commands.executeCommand('mdRunbook.toggleLineCheck', docUri, 2);
        assert.deepEqual(await hintLabels(cell), ['▶ ☑', '▶ ☐', '▶ ☑']);

        void vscode.commands.executeCommand('mdRunbook.runCheckedLines', cell);
        assert.equal(await waitForRun(cell), true, outputText(cell));
        const out = outputText(cell);
        assert.match(out, /one/);
        assert.match(out, /three/);
        assert.doesNotMatch(out, /two/);
        assert.match(out, /lines 1,3/);

        // ▶ on the second line runs only that line.
        void vscode.commands.executeCommand('mdRunbook.runLineAt', docUri, 1);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.match(outputText(cell), /two/);
        assert.match(outputText(cell), /lines 2\b/);
      } finally {
        await setConfig('lines.buttons', undefined);
        await closeAll();
      }
    },
  },
  {
    name: 'breakpoints: a normal run pauses before the line, F5 continues to the next one; one on a comment pauses at the next command',
    fn: async () => {
      const uri = writeFile('breakpoints.md', `# Breakpoints\n\n\`\`\`${LANG}\n${say('one')}\n${say('two')}\n${comment}\n${say('three')}\n\`\`\`\n`);
      const editor = await openRunbook(uri);
      const cell = editor.notebook.cellAt(1);
      const at = (line: number): vscode.SourceBreakpoint => new vscode.SourceBreakpoint(new vscode.Location(cell.document.uri, new vscode.Position(line, 0)));
      // Line 1 ("two"), and line 2 (the comment: it belongs to the command on line 3).
      const bps = [at(1), at(2)];
      vscode.debug.addBreakpoints(bps);
      try {
        // Not awaited: the run only ends once it is continued past its breakpoints.
        await selectKernel(editor);
        void vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 1, end: 2 }], document: editor.notebook.uri });
        await waitPaused(1, cell);
        assert.match(outputText(cell), /one/);
        assert.doesNotMatch(outputText(cell), /two/);

        await vscode.commands.executeCommand('mdRunbook.stepContinue'); // F5: to the next breakpoint
        await waitPaused(2, cell);
        assert.match(outputText(cell), /two/);
        assert.doesNotMatch(outputText(cell), /three/);

        await vscode.commands.executeCommand('mdRunbook.stepContinue');
        assert.equal(await waitForRun(cell), true, outputText(cell));
        assert.match(outputText(cell), /three/);
        assert.doesNotMatch(outputText(cell), /lines /, 'every line ran: a full run');
      } finally {
        vscode.debug.removeBreakpoints(bps);
        await closeAll();
      }
    },
  },
];

/** Checks (expect=), retries and captured values (${out:NAME}) end to end. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, touchAndSave, waitForRun, writeFile } from './suite';

type Progress = { done: number; failed: number };
const progress = (uri: vscode.Uri): Thenable<Progress | undefined> => vscode.commands.executeCommand<Progress>('mdRunbook._progress', uri);
const say = (s: string): string => (isWin ? `Write-Output "${s}"` : `echo "${s}"`);
const fence = (info: string, body: string): string => `\`\`\`${LANG} ${info}\n${body}\n\`\`\`\n\n`;

export const tests: Test[] = [
  {
    name: 'expect=: exit 0 without the expected text fails; expect-exit=3 passes on exit 3',
    fn: async () => {
      const exit3 = isWin ? 'exit 3' : 'exit 3';
      const uri = writeFile('checks-expect.md', `# Checks\n\n${fence('expect="all good"', say('something else'))}${fence('expect-exit=3 expect=/bye/', `${say('bye')}\n${exit3}`)}`);
      try {
        const editor = await openRunbook(uri);
        const [a, b] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(a), false, outputText(a));
        assert.match(outputText(a), /check failed: the output does not contain "all good"/);
        await runCells(editor, 2, 3);
        assert.equal(await waitForRun(b), true, outputText(b));
        assert.match(outputText(b), /check passed/);
        const p = await progress(uri);
        assert.deepEqual([p?.done, p?.failed], [1, 1]);
        await touchAndSave(editor.notebook);
        assert.match(read(uri), /exit=0 .*check=failed/);
        assert.match(read(uri), /exit=3 .*check=ok/);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'retry=: runs again until it passes and keeps only the last attempt',
    fn: async () => {
      // Passes on the third attempt: a counter file in the runbook's folder.
      const body = isWin
        ? "$n = 1 + [int](Get-Content retry-count.txt -ErrorAction SilentlyContinue); Set-Content retry-count.txt $n; Write-Output \"attempt $n\"; if ($n -lt 3) { exit 1 }"
        : 'n=$(( $(cat retry-count.txt 2>/dev/null || echo 0) + 1 )); echo $n > retry-count.txt; echo "attempt $n"; [ "$n" -ge 3 ]';
      const uri = writeFile('checks-retry.md', `# Retry\n\n${fence('retry=5 every=100ms', body)}`);
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(cell), true, outputText(cell));
        const out = outputText(cell);
        assert.match(out, /attempt 3\b/);
        assert.doesNotMatch(out, /attempt 1\b/, 'earlier attempts are not kept');
        assert.match(out, /attempt 3\/5/);
        await touchAndSave(editor.notebook);
        assert.match(read(uri), /attempts=3/);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'capture=: later cells read ${out:NAME}; capture-secret= values are redacted',
    fn: async () => {
      // The token is computed when the cell runs, so it is not in the cell's source (a real secret
      // comes from a command's output).
      const makeToken = isWin ? 'Write-Output "tok-$(4000 + 2)-9f8e"' : 'echo "tok-$((4000 + 2))-9f8e"';
      const uri = writeFile(
        'checks-capture.md',
        `# Capture\n\n${fence('capture="POD:/name: (\\S+)/"', say('name: web-42'))}${fence('', say('got ${out:POD}'))}` +
          `${fence('capture-secret=TOK', makeToken)}${fence('', say('again ${out:TOK}'))}`,
      );
      try {
        const editor = await openRunbook(uri);
        const cells = [1, 2, 3, 4].map((i) => editor.notebook.cellAt(i));
        await runCells(editor, 1, 5);
        for (const c of cells) assert.equal(await waitForRun(c), true, outputText(c));
        assert.match(outputText(cells[1]!), /got web-42/);
        assert.doesNotMatch(outputText(cells[2]!), /tok-4002-9f8e/, 'the capturing cell is redrawn without the secret');
        assert.doesNotMatch(outputText(cells[3]!), /tok-4002-9f8e/);
        await touchAndSave(editor.notebook);
        assert.doesNotMatch(read(uri), /tok-4002-9f8e/);
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: '${out:NAME} without a capture fails the cell with a clear message',
    fn: async () => {
      const uri = writeFile('checks-nocapture.md', `# Missing\n\n${fence('', say('${out:NOPE}'))}`);
      try {
        const editor = await openRunbook(uri);
        const cell = editor.notebook.cellAt(1);
        await runCells(editor, 1, 2);
        assert.equal(await waitForRun(cell), false);
        assert.match(outputText(cell), /\$\{out:NOPE\} has no value yet/);
      } finally {
        await closeAll();
      }
    },
  },
];

/** Run history: a record of each run, "last ran green" in the status bar tooltip, the never-ran hint. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, openRunbook, outputText, runCells, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const fence = (body: string): string => `\`\`\`${LANG}\n${body}\n\`\`\`\n`;
const NEVER_RAN = 'This step has never run here.';

interface Run {
  started: number;
  ended: number;
  by?: string;
  cells: number[];
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  complete: number;
  green: boolean;
  single?: { cell: number; step?: number; label: string };
}

/** Polls an async check until it holds (waitFor in suite.ts takes a plain function). */
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('each run is recorded, the tooltip says when it last ran green, a step that never ran gets a hint', async () => {
  const uri = writeFile('runs-history.md', `# Runs\n\n${fence('echo one')}\n${fence('echo two')}`);
  const editor = await openRunbook(uri);
  const [, one, two] = editor.notebook.getCells();
  const runs = async (): Promise<Run[]> => (await vscode.commands.executeCommand<Run[]>('mdRunbook._runs', uri)) ?? [];
  const tooltip = async (): Promise<string> => (await vscode.commands.executeCommand<{ status: { tooltip: string } }>('mdRunbook._estimates', uri))!.status.tooltip;
  const markers = (cell: vscode.NotebookCell): Thenable<string[]> => vscode.commands.executeCommand<string[]>('mdRunbook._diagnostics', cell.document.uri);
  // A repeated run of the suite (MD_RUNBOOK_ITEST_REPEAT) finds the records of the last one.
  const before = (await runs()).length;
  if (before === 0) {
    assert.match(await tooltip(), /Never ran green/);
    assert.ok(!(await markers(two!)).includes(NEVER_RAN), 'no hint before the first run');
  }

  // One step on its own: recorded, not green (the other is to do), and the other gets the hint.
  await runCells(editor, 1, 2);
  assert.equal(await waitForRun(one!), true, outputText(one!));
  const first = await until('the first record', async () => {
    const r = await runs();
    return r.length === before + 1 && r[0];
  });
  assert.deepEqual(first.cells, [1]);
  assert.deepEqual([first.passed, first.failed, first.skipped, first.total, first.complete, first.green], [1, 0, 0, 2, 1, false]);
  assert.deepEqual([first.single?.cell, first.single?.step], [1, 1]);
  assert.ok(first.by, 'who ran it');
  assert.ok(first.started <= first.ended);
  if (before === 0) {
    assert.match(await tooltip(), /Never ran green/);
    await until('the never-ran hint', async () => (await markers(two!)).includes(NEVER_RAN));
    assert.ok(!(await markers(one!)).includes(NEVER_RAN), 'the step that ran has none');
  }

  // Both: green, newest first, and the hint goes (the step has run, and has an output).
  await runCells(editor, 1, 3);
  assert.equal(await waitForRun(two!), true, outputText(two!));
  const second = await until('the second record', async () => {
    const r = await runs();
    return r.length === before + 2 && r[0];
  });
  assert.deepEqual(second.cells, [1, 2]);
  assert.deepEqual([second.passed, second.failed, second.total, second.complete, second.green], [2, 0, 2, 2, true]);
  assert.equal(second.single, undefined);
  assert.match(await tooltip(), /Last ran green: just now/);
  await until('the hint to go', async () => !(await markers(two!)).includes(NEVER_RAN));
  await closeAll();
});

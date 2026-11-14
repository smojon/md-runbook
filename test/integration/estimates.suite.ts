/** estimate=: each block's estimate on its status line, a running block's bar, the runbook's time left. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import type { RunbookEstimate } from '@md-runbook/core';
import { LANG, Test, closeAll, isWin, openRunbook, runCells, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

interface Estimates {
  status: { text: string; tooltip: string };
  runbook: RunbookEstimate;
  cells: (string | undefined)[];
}
const estimates = async (): Promise<Estimates> => (await vscode.commands.executeCommand<Estimates>('mdRunbook._estimates'))!;
const fence = (info: string, body: string): string => `\`\`\`${LANG} ${info}\n${body}\n\`\`\`\n`;
const sleep = (s: number): string => (isWin ? `Start-Sleep -Seconds ${s}` : `sleep ${s}`);

test('estimate=: the block shows it, a run shows its bar, the status bar the time left', async () => {
  const uri = writeFile('estimates.md', `# Steps\n\n${fence('estimate=10m', 'echo one')}\n${fence('', 'echo two')}\n${fence('estimate=1', sleep(4))}`);
  const editor = await openRunbook(uri);
  const before = await estimates();
  assert.deepEqual(before.cells, [undefined, '$(watch) est. 10m', undefined, '$(watch) est. 1s']);
  assert.equal(before.runbook.totalSeconds, 601);
  assert.equal(before.runbook.unestimated, 1);
  assert.match(before.status.text, /^\$\(checklist\) 0\/3 · ~10 min$/);
  assert.match(before.status.tooltip, /\*\*0 of 3 steps done\*\* · 0% by the estimates · 10 min left · done ≈ \d\d:\d\d/);
  assert.match(before.status.tooltip, /1 block without an estimate/);

  // The sleeping block: past its estimate of 1 s, the bar stays full and says how much over.
  const cell = editor.notebook.cellAt(3);
  void runCells(editor, 3, 4);
  let over: Estimates | undefined;
  for (const end = Date.now() + 30_000; !over && Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const e = await estimates();
    if (/^\$\(warning\) █{24} \+\d+s over 1s$/.test(e.cells[3] ?? '')) over = e;
  }
  assert.ok(over, 'the running block went over its estimate');
  assert.equal(over.runbook.leftSeconds, 600, 'the running block has nothing left of its estimate');
  await waitForRun(cell);
  const after = await estimates();
  // A few seconds over is no warning (a slow machine may show how long it took, 10 s and more over).
  assert.match(after.cells[3] ?? '', /^\$\(watch\) est\. 1s( · took \d+s \(\+\d+s\))?$/);
  assert.equal(after.runbook.doneSeconds, 1);
  await closeAll();
});

test('estimate=: a runbook without estimates shows nothing of them', async () => {
  const uri = writeFile('estimates-none.md', `# Steps\n\n${fence('', 'echo one')}`);
  await openRunbook(uri);
  const e = await estimates();
  assert.deepEqual(e.cells, [undefined, undefined]);
  assert.equal(e.status.text, '$(checklist) 0/1');
  assert.doesNotMatch(e.status.tooltip, /estimate/);
  await closeAll();
});

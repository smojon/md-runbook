/** Progress: manual marks, checklist items, Resume Run, Clear Outputs Above/Below. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import type { Progress } from '../../src/core';
import { LANG, Test, closeAll, openRunbook, outputText, read, runCells, selectKernel, step, waitFor, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const progress = async (): Promise<Progress> => (await vscode.commands.executeCommand<Progress>('mdRunbook._progress'))!;
const fence = (body: string): string => `\`\`\`${LANG}\n${body}\n\`\`\`\n`;

test('Mark Step Done / Skipped records a manual output that is saved', async () => {
  const uri = writeFile('progress-mark.md', `# Steps\n\n${fence('echo one')}\n${fence('echo two')}\n${fence('echo three')}`);
  const editor = await openRunbook(uri);
  const nb = editor.notebook;
  const [, one, two] = nb.getCells();
  assert.deepEqual({ ...(await progress()) }, { total: 3, done: 0, failed: 0, skipped: 0, pending: 3, firstPending: { cell: 1, step: 1 }, resume: [1, 2, 3] });

  await step('mark done', vscode.commands.executeCommand('mdRunbook.markStepDone', one));
  await step('mark skipped', vscode.commands.executeCommand('mdRunbook.markStepSkipped', two));
  await waitFor('marks', () => /marked done by /.test(outputText(one!)) && /marked skipped by /.test(outputText(two!)));
  await waitFor('success', () => one!.executionSummary?.success === true);
  const p = await progress();
  assert.equal(p.done, 1);
  assert.equal(p.skipped, 1);
  assert.deepEqual(p.resume, [3]);

  assert.ok(await step('save', nb.save()));
  const saved = read(uri);
  assert.match(saved, /echo one\n```\n<!-- md-runbook:output start exit=done ran=\S+ by=\S+ -->\n```text\n\[md-runbook\] marked done by /);
  assert.match(saved, /echo two\n```\n<!-- md-runbook:output start exit=skipped /);
  await closeAll();

  // Reopened: the persisted marks still count.
  const again = await openRunbook(uri);
  const q = await progress();
  assert.equal(q.done, 1);
  assert.equal(q.skipped, 1);

  // Unmark clears the mark again.
  await step('unmark', vscode.commands.executeCommand('mdRunbook.unmarkStep', again.notebook.cellAt(1)));
  await waitFor('unmarked', () => again.notebook.cellAt(1).outputs.length === 0);
  assert.equal((await progress()).done, 0);
  await closeAll();
});

test('Unmark Step leaves a real run recorded as skipped alone', async () => {
  const uri = writeFile('progress-unmark-real.md', `# Steps\n\n\`\`\`${LANG} skip\necho never\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  const cell = editor.notebook.cellAt(1);
  await runCells(editor, 1, 2);
  await waitForRun(cell);
  assert.match(outputText(cell), /skipped: skip option/);
  await step('unmark', vscode.commands.executeCommand('mdRunbook.unmarkStep', cell));
  assert.ok(cell.outputs.length > 0, 'the skip-option run keeps its output');
  await closeAll();
});

test('Check Next Item ticks task-list items, which count as steps', async () => {
  const uri = writeFile('progress-checklist.md', `# Prep\n\n- [x] ask for access\n- [ ] announce\n- [ ] freeze deploys\n\n${fence('echo go')}`);
  const editor = await openRunbook(uri);
  let p = await progress();
  assert.equal(p.total, 4);
  assert.equal(p.done, 1);
  assert.deepEqual(p.firstPending, { cell: 0, step: 2 });

  await step('check next', vscode.commands.executeCommand('mdRunbook.checkNextItem', editor.notebook.cellAt(0)));
  p = await progress();
  assert.equal(p.done, 2);
  assert.ok(await step('save', editor.notebook.save()));
  assert.match(read(uri), /- \[x\] announce\n- \[ \] freeze deploys\n/);
  await closeAll();
});

test('Resume Run continues from the failed step after it is fixed', async () => {
  const uri = writeFile('progress-resume.md', `${fence('echo first')}\n${fence('echo broken\nexit 3')}\n${fence('echo third')}`);
  const editor = await openRunbook(uri);
  const nb = editor.notebook;
  await selectKernel(editor);
  await vscode.commands.executeCommand('notebook.execute', nb.uri);
  const [c0, c1, c2] = nb.getCells();
  assert.equal(await waitForRun(c0!), true);
  assert.equal(await waitForRun(c1!), false);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(c2!.outputs.length, 0);
  let p = await progress();
  assert.deepEqual(p.firstFailed, { cell: 1, step: 2 });
  assert.deepEqual(p.resume, [1, 2]);
  const firstOrder = c0!.executionSummary?.executionOrder;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(c1!.document.uri, new vscode.Range(0, 0, c1!.document.lineCount, 0), 'echo fixed');
  assert.ok(await vscode.workspace.applyEdit(edit));
  await step('resume', vscode.commands.executeCommand('mdRunbook.resumeRun'));
  await waitFor('third cell', () => /third/.test(outputText(c2!)) && c2!.executionSummary?.timing?.endTime !== undefined);
  assert.equal(c1!.executionSummary?.success, true, outputText(c1!));
  assert.match(outputText(c1!), /fixed/);
  assert.equal(c0!.executionSummary?.executionOrder, firstOrder, 'first cell must not run again');
  p = await progress();
  assert.equal(p.done, 3);
  assert.deepEqual(p.resume, []);
  await closeAll();
});

test('Clear Outputs Above / Below', async () => {
  const uri = writeFile('progress-clear.md', `${fence('echo a')}\n${fence('echo b')}\n${fence('echo c')}`);
  const editor = await openRunbook(uri);
  const nb = editor.notebook;
  await runCells(editor, 0, 3);
  for (const c of nb.getCells()) assert.equal(await waitForRun(c), true, outputText(c));

  await step('clear above', vscode.commands.executeCommand('mdRunbook.clearOutputsAbove', nb.cellAt(1)));
  await waitFor('cleared above', () => nb.cellAt(0).outputs.length === 0);
  assert.ok(nb.cellAt(1).outputs.length > 0 && nb.cellAt(2).outputs.length > 0);

  await step('clear below', vscode.commands.executeCommand('mdRunbook.clearOutputsBelow', nb.cellAt(1)));
  await waitFor('cleared below', () => nb.cellAt(1).outputs.length === 0 && nb.cellAt(2).outputs.length === 0);
  assert.equal((await progress()).pending, 3);
  await closeAll();
});

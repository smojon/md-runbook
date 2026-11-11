/** Runbook calls in VS Code: a ```runbook cell runs another runbook as a copy, as one step. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, openRunbook, outputText, read, runCells, step, waitFor, waitForRun, work, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const child = (second: string): string =>
  [
    '---',
    'params:',
    '  - ENV',
    '---',
    '',
    '# Child',
    '',
    '## Part A',
    '',
    '```' + LANG + ' name="first"',
    'echo "A ${param:ENV}"',
    '```',
    '',
    '## Part B',
    '',
    '```' + LANG + ' name="second"',
    second,
    '```',
    '',
  ].join('\n');

const parent = (call: string): string => ['# Parent', '', '```' + LANG, 'echo before', '```', '', call, '', '```' + LANG, 'echo after', '```', ''].join('\n');

/** A cell's output without colours (the ✓ and ✗ are coloured). */
const plain = (cell: vscode.NotebookCell): string => outputText(cell).replace(/\x1b\[[0-9;]*m/g, '');

/** The copies of `name` made in the work folder. */
const copies = (name: string): string[] => fs.readdirSync(work).filter((f) => f.startsWith(name.replace(/\.md$/, '.')) && /\.\d{8}-\d{6}(-\d+)?\.md$/.test(f));

test('a runbook call runs the runbook called as a copy, with the parameters it passes', async () => {
  writeFile('call-child.md', child('echo "B ${param:ENV}"'));
  const uri = writeFile('call-parent.md', parent('```runbook name="Apply" src=call-child.md\nENV=dev\n```'));
  const editor = await openRunbook(uri);
  const cell = editor.notebook.cellAt(2);
  assert.equal(cell.document.languageId, 'runbook');
  await step('run the call', runCells(editor, 2, 3));
  assert.equal(await waitForRun(cell, 90_000), true, outputText(cell));
  const out = plain(cell);
  assert.match(out, /running call-child\.md as call-child\.\d{8}-\d{6}\.md/);
  assert.match(out, /✓ first/);
  assert.match(out, /2 done · sha256 [0-9a-f]{64}/);
  // The child stays a template; the copy holds the outputs with the parameter passed (never asked).
  assert.doesNotMatch(read(vscode.Uri.file(path.join(work, 'call-child.md'))), /md-runbook:output/);
  const [copy] = copies('call-child.md');
  assert.ok(copy, 'no copy');
  const copyText = fs.readFileSync(path.join(work, copy!), 'utf8');
  assert.match(copyText, /A dev/);
  assert.match(copyText, /B dev/);
  assert.ok(await step('save', editor.notebook.save()));
  assert.match(read(uri), new RegExp(`output start exit=0 [^\\n]*runbook=call-child\\.md copy=${copy!.replace(/\./g, '\\.')} sha256=[0-9a-f]{64} steps="2 done"`));
  await closeAll();
});

test('a failed call stops Run All; run again, it continues its copy; Fresh copy starts another', async () => {
  const flag = path.join(work, 'call-flag.txt').replace(/\\/g, '/');
  const check = LANG === 'pwsh' ? `if (-not (Test-Path "${flag}")) { exit 3 }; echo "B ok"` : `test -f "${flag}" && echo "B ok"`;
  writeFile('call-child2.md', child(check));
  const uri = writeFile('call-parent2.md', parent('```runbook src=call-child2.md\nENV=dev\n```'));
  const editor = await openRunbook(uri);
  await step('run all', runCells(editor, 0, editor.notebook.cellCount));
  const call = editor.notebook.cellAt(2);
  assert.equal(await waitForRun(call, 90_000), false, outputText(call));
  assert.match(plain(call), /1 done, 1 failed/);
  // Run All stopped at the call: the cell after it has no output.
  await waitFor('run all to stop', () => editor.notebook.cellAt(4).executionSummary === undefined || editor.notebook.cellAt(4).outputs.length === 0);
  const [first] = copies('call-child2.md');

  fs.writeFileSync(flag, '');
  const before = call.executionSummary?.timing?.endTime ?? 0;
  await step('run again', runCells(editor, 2, 3));
  await waitFor('second run', () => (call.executionSummary?.timing?.endTime ?? 0) > before, 90_000);
  assert.equal(call.executionSummary?.success, true, outputText(call));
  assert.match(plain(call), /continuing call-child2\.md as call-child2\.\d{8}-\d{6}\.md \(steps done there are kept\)/);
  assert.deepEqual(copies('call-child2.md'), [first]);

  const again = call.executionSummary?.timing?.endTime ?? 0;
  await step('fresh copy', vscode.commands.executeCommand('mdRunbook.runCallFresh', call));
  await waitFor('fresh run', () => (call.executionSummary?.timing?.endTime ?? 0) > again, 90_000);
  assert.equal(call.executionSummary?.success, true, outputText(call));
  assert.equal(copies('call-child2.md').length, 2);
  await closeAll();
});

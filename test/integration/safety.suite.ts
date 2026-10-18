/** Per-cell fence options, confirmation settings and context recording. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, selectKernel, setConfig, step, waitForRun, work, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

test('safety: continue-on-error keeps Run All going; skip is recorded', async () => {
  const uri = writeFile(
    'safety-continue.md',
    `\`\`\`${LANG} continue-on-error\nexit 3\n\`\`\`\n\n\`\`\`${LANG} skip\necho never\n\`\`\`\n\n\`\`\`${LANG}\necho 'still runs'\n\`\`\`\n`,
  );
  const editor = await openRunbook(uri);
  await selectKernel(editor);
  await vscode.commands.executeCommand('notebook.execute', editor.notebook.uri);
  const [c0, c1, c2] = editor.notebook.getCells();
  assert.equal(await waitForRun(c0!), false);
  await waitForRun(c1!);
  assert.match(outputText(c1!), /skipped: skip option/);
  assert.doesNotMatch(outputText(c1!), /never/);
  assert.equal(await waitForRun(c2!), true, outputText(c2!));
  assert.match(outputText(c2!), /still runs/);
  assert.ok(await step('save', editor.notebook.save()));
  const saved = read(uri);
  assert.match(saved, /exit=3/);
  assert.match(saved, /exit=skipped/);
  assert.match(saved, /still runs/);
  await closeAll();
});

test('safety: timeout option kills the cell', async () => {
  const sleep = isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const uri = writeFile('safety-timeout.md', `\`\`\`${LANG} timeout=1\necho before\n${sleep}\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  const started = Date.now();
  await runCells(editor, 0, 1);
  assert.equal(await waitForRun(editor.notebook.cellAt(0), 20_000), false);
  assert.ok(Date.now() - started < 15_000);
  assert.match(outputText(editor.notebook.cellAt(0)), /timed out after 1\.0s/);
  assert.ok(await step('save', editor.notebook.save()));
  assert.match(read(uri), /exit=timeout/);
  await closeAll();
});

test('safety: cwd and env options', async () => {
  fs.mkdirSync(path.join(work, 'safety-sub'), { recursive: true });
  const body = isWin ? '(Get-Location).Path\nWrite-Output "region=$env:MDR_REGION"' : 'pwd\necho "region=$MDR_REGION"';
  const uri = writeFile('safety-cwd.md', `\`\`\`${LANG} cwd=safety-sub env.MDR_REGION="eu west"\n${body}\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  await runCells(editor, 0, 1);
  const cell = editor.notebook.cellAt(0);
  assert.equal(await waitForRun(cell), true, outputText(cell));
  assert.match(outputText(cell), /safety-sub/);
  assert.match(outputText(cell), /region=eu west/);
  await closeAll();
});

test('safety: confirm=never runs risky cells without asking', async () => {
  await setConfig('execution.confirm', 'never');
  try {
    const uri = writeFile('safety-never.md', `\`\`\`${LANG}\necho 'kubectl delete pod x'\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0)), true);
    assert.match(outputText(editor.notebook.cellAt(0)), /kubectl delete pod x/);
  } finally {
    await setConfig('execution.confirm', undefined);
    await closeAll();
  }
});

test('safety: recordContext writes an attribute to the marker', async () => {
  // `echo` works the same in cmd.exe and /bin/sh.
  await setConfig('output.recordContext', { context: 'echo prod-eu', server: 'echo https://api.example:6443' });
  try {
    const uri = writeFile('safety-context.md', `\`\`\`${LANG} name="Check it"\necho hi\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0)), true);
    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /<!-- md-runbook:output start exit=0 .* name="Check it" context=prod-eu server=https:\/\/api\.example:6443 -->/);
  } finally {
    await setConfig('output.recordContext', undefined);
    await closeAll();
  }
});

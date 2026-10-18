/** Secrets, inputs, runbook parameters and .env files: values arrive as env vars and never reach disk. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, setConfig, step, waitFor, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

/** A cell that prints `label=<length of value>` for a reference, so the value itself never prints. */
const lengthOf = (label: string, ref: string): string =>
  isWin ? `$x = "${ref}"; Write-Output "${label}=$($x.Length)"` : `x="${ref}"; echo "${label}=\${#x}"`;
const echo = (text: string): string => (isWin ? `Write-Output "${text}"` : `echo "${text}"`);

const FRONT = '---\ntitle: Deploy\nparams:\n  - REGION: eu-west-1\n---\n\n# Deploy\n\n';

test('.env values are injected and redacted live and on disk', async () => {
  const value = 'dotenv-value-12345';
  writeFile('.env', `# test\nexport MDRB_DOTENV_TOKEN="${value}"\n`);
  await setConfig('execution.envFile', '.env');
  try {
    const ref = isWin ? '$env:MDRB_DOTENV_TOKEN' : '$MDRB_DOTENV_TOKEN';
    const uri = writeFile('dotenv.md', `\`\`\`${LANG}\n${lengthOf('len', ref)}\n${echo(`v=${ref}`)}\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(cell), true, outputText(cell));
    assert.match(outputText(cell), /len=18/);
    assert.match(outputText(cell), /v=\[REDACTED\]/);
    assert.ok(await step('save', editor.notebook.save()));
    assert.doesNotMatch(read(uri), new RegExp(value));
    assert.match(read(uri), /v=\[REDACTED\]/);
  } finally {
    await setConfig('execution.envFile', undefined);
    await closeAll();
  }
});

test('params: front-matter default, Set Parameters values, Reset Inputs', async () => {
  await setConfig('params.useDefaults', true);
  try {
    const uri = writeFile('params.md', `${FRONT}\`\`\`${LANG}\n${echo('region=${param:REGION}')}\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code)!;
    const run = async (): Promise<string> => {
      await runCells(editor, cell.index, cell.index + 1);
      assert.equal(await waitForRun(cell), true, outputText(cell));
      return outputText(cell);
    };
    assert.match(await run(), /region=eu-west-1/);

    await vscode.commands.executeCommand('mdRunbook.setParameters', { REGION: 'us-east-1' });
    assert.match(await run(), /region=us-east-1/);

    await vscode.commands.executeCommand('mdRunbook.resetInputs');
    assert.match(await run(), /region=eu-west-1/);

    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /region=\$\{param:REGION\}/, 'the reference stays in the source on disk');
  } finally {
    await setConfig('params.useDefaults', undefined);
    await closeAll();
  }
});

test('stored secrets are injected as env vars and never persisted', async () => {
  const value = 's3cr3t-value-xyz';
  await vscode.commands.executeCommand('mdRunbook.setSecret', 'MDRB_TEST_SECRET', value);
  try {
    const uri = writeFile('secret.md', `\`\`\`${LANG}\n${lengthOf('len', '${secret:MDRB_TEST_SECRET}')}\n${echo('v=${secret:MDRB_TEST_SECRET}')}\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(cell), true, outputText(cell));
    assert.match(outputText(cell), /len=16/);
    assert.match(outputText(cell), /v=\[REDACTED\]/);
    assert.doesNotMatch(outputText(cell), new RegExp(value));
    assert.ok(await step('save', editor.notebook.save()));
    assert.doesNotMatch(read(uri), new RegExp(value));
  } finally {
    await vscode.commands.executeCommand('mdRunbook.deleteSecret', 'MDRB_TEST_SECRET');
    await closeAll();
  }
});

test('cancelling an input fails the cell without running it', async () => {
  const uri = writeFile('input.md', `\`\`\`${LANG}\n${echo('ran ${input:MDRB_ASK}')}\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  const cell = editor.notebook.cellAt(0);
  const running = runCells(editor, 0, 1);
  // Dismiss the input box (like Escape) until the cell finishes.
  await waitFor(
    'input cancelled',
    () => {
      void vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      return cell.executionSummary?.timing?.endTime !== undefined;
    },
    20_000,
  );
  await step('execute command', running);
  assert.equal(cell.executionSummary?.success, false);
  assert.match(outputText(cell), /input MDRB_ASK cancelled/);
  assert.doesNotMatch(outputText(cell), /ran /);
  await closeAll();
});

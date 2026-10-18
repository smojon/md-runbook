/** Terminal mode: off by default; with perCell, `terminal` cells run in a VS Code terminal (interactive). */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, setConfig, step, waitFor, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

test('terminal: the terminal option is ignored while terminal.mode is off (default)', async () => {
  const uri = writeFile('term-off.md', `\`\`\`${LANG} terminal\necho plain\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  try {
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0)), true);
    assert.doesNotMatch(outputText(editor.notebook.cellAt(0)), /terminal/, 'ran normally, not in a terminal');
    assert.equal(vscode.window.terminals.filter((t) => t.name.startsWith('md-runbook:')).length, 0);
  } finally {
    await closeAll();
  }
});

test('terminal: a terminal cell answers an interactive prompt and its output is saved', async () => {
  await setConfig('terminal.mode', 'perCell');
  try {
    const body = isWin ? "$n = Read-Host 'Name'\nWrite-Output \"hello $n\"" : 'read -r -p "Name: " n\necho "hello $n"';
    const uri = writeFile('term-prompt.md', `\`\`\`${LANG} terminal\n${body}\n\`\`\`\n\n\`\`\`${LANG} terminal\nexit 3\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    const running = runCells(editor, 0, 1);
    const terminal = await waitFor('md-runbook terminal', () => vscode.window.terminals.find((t) => t.name.startsWith('md-runbook: term-prompt.md')), 20_000);
    // Answer the prompt by typing into the terminal, as a user would.
    await new Promise((r) => setTimeout(r, 2000));
    terminal.sendText('bob');
    const ok = await waitForRun(cell, 30_000);
    await step('execute', running);
    if (/shell integration did not start|needs VS Code 1\.93/.test(outputText(cell))) {
      throw new Error(`terminal shell integration unavailable here: ${outputText(cell)}`);
    }
    assert.equal(ok, true, outputText(cell));
    assert.match(outputText(cell), /hello bob/);
    assert.match(outputText(cell), /terminal/, 'status line names the terminal');

    // Exit codes come through.
    // The second code cell is index 1: there is no Markdown cell between the two blocks.
    await runCells(editor, 1, 2);
    assert.equal(await waitForRun(editor.notebook.cellAt(1), 30_000), false);
    assert.match(outputText(editor.notebook.cellAt(1)), /exit code 3/);

    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /hello bob/);
    assert.match(read(uri), /exit=3/);
  } finally {
    await setConfig('terminal.mode', undefined);
    await closeAll();
  }
});

test('terminal: assistant-written cells never run in a terminal', async () => {
  await setConfig('terminal.mode', 'perCell');
  await setConfig('approval.trustFileApprovals', true);
  await setConfig('approval.readOnlyEnv', { MDRB_READONLY: 'yes' });
  try {
    const uri = writeFile('term-ai.md', `\`\`\`${LANG} terminal approved-by=me approved-at=now by=ai reason="probe"\necho nope\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0)), false);
    assert.match(outputText(editor.notebook.cellAt(0)), /never run in a terminal/);
  } finally {
    await setConfig('approval.readOnlyEnv', undefined);
    await setConfig('approval.trustFileApprovals', undefined);
    await setConfig('terminal.mode', undefined);
    await closeAll();
  }
});

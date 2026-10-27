/** Terminal mode: off by default; with perCell, `terminal` cells run in a VS Code terminal (interactive). */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, setConfig, step, waitFor, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

test('terminal: the terminal option runs normally, with a note, while terminal.mode is off (default)', async () => {
  const uri = writeFile('term-off.md', `\`\`\`${LANG} terminal\necho plain\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  try {
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0)), true);
    const out = outputText(editor.notebook.cellAt(0));
    assert.match(out, /plain/);
    assert.match(out, /terminal option ignored: set "mdRunbook.terminal.mode"/, 'explains why there is no terminal');
    assert.equal(vscode.window.terminals.filter((t) => t.name.startsWith('md-runbook:')).length, 0);
  } finally {
    await closeAll();
  }
});

test('terminal: a terminal cell answers an interactive prompt and its output is saved', async () => {
  await setConfig('terminal.mode', 'perCell');
  try {
    // `ready` shows the cell's own process is running, so typed input reaches it (not the outer shell).
    const body = isWin ? "Write-Output 'ready'\n$n = Read-Host 'Name'\nWrite-Output \"hello $n\"" : 'echo ready\nread -r -p "Name: " n\necho "hello $n"';
    const uri = writeFile('term-prompt.md', `\`\`\`${LANG} terminal\n${body}\n\`\`\`\n\n\`\`\`${LANG} terminal\nexit 3\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    const running = runCells(editor, 0, 1);
    const terminal = await waitFor('md-runbook terminal', () => vscode.window.terminals.find((t) => t.name.startsWith('md-runbook: term-prompt.md')), 20_000);
    // Answer the prompt by typing into the terminal, as a user would, once the cell is running.
    await waitFor('cell to start', () => /ready/.test(outputText(cell)), 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    terminal.sendText('bob');
    const ok = await waitForRun(cell, 30_000);
    await step('execute', running);
    if (/shell integration did not start|needs VS Code 1\.93/.test(outputText(cell))) {
      throw new Error(`terminal shell integration unavailable here: ${outputText(cell)}`);
    }
    assert.equal(ok, true, outputText(cell));
    assert.match(outputText(cell), /hello bob/);
    assert.match(outputText(cell), /terminal/, 'status line names the terminal');
    // The cell shown in the terminal before it runs is not part of its output.
    assert.doesNotMatch(outputText(cell), /(?:\$|PS>) (?:echo ready|Write-Output 'ready')/);

    // Exit codes come through.
    // The second code cell is index 1: there is no Markdown cell between the two blocks.
    await runCells(editor, 1, 2);
    assert.equal(await waitForRun(editor.notebook.cellAt(1), 30_000), false);
    assert.match(outputText(editor.notebook.cellAt(1)), /exit code 3/);

    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /hello bob/);
    assert.match(read(uri), /exit=3/);
    assert.doesNotMatch(read(uri), /MdRunbookShown|\$ echo ready|PS> Write-Output/);
  } finally {
    await setConfig('terminal.mode', undefined);
    await closeAll();
  }
});

test('terminal: a cmd cell runs from a PowerShell terminal and answers a prompt (Windows)', async () => {
  if (!isWin) return;
  await setConfig('terminal.mode', 'perCell');
  try {
    const uri = writeFile('term-cmd.md', '```cmd terminal\necho ready\nset /p n=Name: \necho hello %n%\nexit /b 4\n```\n');
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    const running = runCells(editor, 0, 1);
    const terminal = await waitFor('md-runbook terminal', () => vscode.window.terminals.find((t) => t.name.startsWith('md-runbook: term-cmd.md')), 20_000);
    await waitFor('cell to start', () => /ready/.test(outputText(cell)), 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    terminal.sendText('ann');
    const ok = await waitForRun(cell, 30_000);
    await step('execute', running);
    assert.equal(ok, false, outputText(cell));
    assert.match(outputText(cell), /hello ann/);
    assert.match(outputText(cell), /exit code 4/);
    assert.match(outputText(cell), /cmd terminal/, 'status line names the cmd terminal');
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

test('terminal: a line run keeps cd between lines in a terminal of its own, closed afterwards', async () => {
  await setConfig('terminal.mode', 'perCell');
  try {
    const cd = isWin ? 'Set-Location $env:TEMP' : 'cd /tmp';
    const where = isWin ? 'Write-Output "WHERE=$((Get-Location).Path)"' : 'echo "WHERE=$(pwd)"';
    const uri = writeFile('term-lines.md', `\`\`\`${LANG} terminal\n${cd}\n${where}\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const cell = editor.notebook.cellAt(0);
    void vscode.commands.executeCommand('mdRunbook.runLinesOneByOne', cell);
    // On a timeout, show how far it got (which line, what the terminal printed).
    const ok = await waitForRun(cell, 60_000).catch((e: Error) => {
      const terms = vscode.window.terminals.map((t) => t.name).join(', ');
      throw new Error(`${e.message}; output so far: ${JSON.stringify(outputText(cell))}; terminals: ${terms}`);
    });
    assert.equal(ok, true, outputText(cell));
    const out = outputText(cell);
    assert.match(out, isWin ? /WHERE=.*Temp/i : /WHERE=(\/private)?\/tmp/);
    await waitFor('the line-run terminal to close', () => !vscode.window.terminals.some((t) => t.name.includes(', lines)')) || undefined, 10_000);
  } finally {
    await setConfig('terminal.mode', undefined);
    await closeAll();
  }
});

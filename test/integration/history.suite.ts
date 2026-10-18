/** Output history, Run All as Copy and Compare With Previous Run. */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, read, runCells, setConfig, step, waitFor, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

/** A cell that prints `run N`, N counting up on every run. */
const counterCell = (file: string): string =>
  isWin
    ? `$n = 0; if (Test-Path ${file}) { $n = [int](Get-Content ${file}) }\n$n++\nSet-Content ${file} $n\nWrite-Output "run $n"`
    : `n=$(cat ${file} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${file}\necho "run $n"`;

const runs = (text: string): string[] => [...text.matchAll(/^run (\d+)$/gm)].map((m) => m[1]!);

/** Run the code cell (index 1) and wait for `run N`. */
async function runAndWait(editor: vscode.NotebookEditor, n: number): Promise<void> {
  await step(`run ${n}`, runCells(editor, 1, 2));
  const cell = editor.notebook.cellAt(1);
  await waitFor(`run ${n} output`, () => new RegExp(`run ${n}\\b`).test(outputText(cell)) && /exit code 0/.test(outputText(cell)));
}

test('history keeps previous runs, newest first, trimmed to historySize', async () => {
  await setConfig('output.historySize', 2);
  try {
    writeFile('hist-counter.txt', '0');
    const uri = writeFile('history.md', `# History\n\n\`\`\`${LANG}\n${counterCell('hist-counter.txt')}\n\`\`\`\n\nAfter.\n`);
    let editor = await openRunbook(uri);
    for (const n of [1, 2, 3]) await runAndWait(editor, n);
    assert.ok(await step('save', editor.notebook.save()));

    let saved = read(uri);
    assert.equal(saved.match(/md-runbook:output start/g)?.length, 3, saved);
    assert.match(saved, /<details><summary>md-runbook: 2 previous runs<\/summary>/);
    assert.deepEqual(runs(saved), ['3', '2', '1']);
    assert.match(saved, /output start exit=0 [^\n]*changed=yes -->\n```text\nrun 3\n/);
    assert.match(saved, /<\/details>\n\nAfter\.\n$/);

    await runAndWait(editor, 4);
    assert.ok(await step('save', editor.notebook.save()));
    assert.deepEqual(runs(read(uri)), ['4', '3', '2']);

    // Compare With Previous Run opens a diff of the two latest outputs.
    await step('compare', vscode.commands.executeCommand('mdRunbook.compareWithPreviousRun', editor.notebook.cellAt(1)));
    const tab = await waitFor('diff editor', () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.original.scheme === 'md-runbook-run' ? input : undefined;
    });
    assert.equal((await vscode.workspace.openTextDocument(tab.original)).getText(), 'run 3\n');
    assert.equal((await vscode.workspace.openTextDocument(tab.modified)).getText(), 'run 4\n');
    await closeAll();

    // Reopened: history is not shown as cells; re-running a loaded output keeps its bytes.
    editor = await openRunbook(uri);
    assert.equal(editor.notebook.cellCount, 3);
    assert.match(outputText(editor.notebook.cellAt(1)), /run 4/);
    const before = read(uri);
    const end = '<!-- md-runbook:output end -->\n';
    const latest = before.slice(before.indexOf('<!-- md-runbook:output start'), before.indexOf(end) + end.length);
    await runAndWait(editor, 5);
    assert.ok(await step('save', editor.notebook.save()));
    saved = read(uri);
    assert.deepEqual(runs(saved), ['5', '4', '3']);
    assert.ok(saved.includes('\n\n' + latest + '\n'), 'loaded output is kept byte for byte as history');
  } finally {
    await setConfig('output.historySize', undefined);
    await closeAll();
  }
});

test('Run All as Copy writes a timestamped copy with outputs and leaves the original alone', async () => {
  const stale = '<!-- md-runbook:output start exit=0 ran=old -->\n```text\nstale\n```\n<!-- md-runbook:output end -->\n';
  const src = `# Copy\n\n\`\`\`${LANG}\necho copy-run\n\`\`\`\n${stale}\n\`\`\`${LANG}\n${isWin ? 'Get-Content marker.txt' : 'cat marker.txt'}\n\`\`\`\n`;
  const uri = writeFile('ascopy.md', src);
  writeFile('marker.txt', 'marker-content\n');
  await openRunbook(uri);
  try {
    const copy = await step('run all as copy', vscode.commands.executeCommand<vscode.Uri>('mdRunbook.runAllAsCopy', uri), 60_000);
    assert.ok(copy, 'command returns the copy');
    assert.match(path.basename(copy.fsPath), /^ascopy\.\d{8}-\d{6}\.md$/);
    assert.equal(path.dirname(copy.fsPath), path.dirname(uri.fsPath));
    const out = read(copy);
    assert.match(out, /output start exit=0 [^\n]*-->\n```text\ncopy-run\n/);
    assert.match(out, /marker-content/);
    assert.doesNotMatch(out, /stale/);
    assert.equal(read(uri), src, 'original unchanged');
    await closeAll();

    // copyFolder: the copy goes to a subfolder, but cells still run in the original folder.
    await setConfig('output.copyFolder', 'runs');
    const copy2 = await step('run all as copy (folder)', vscode.commands.executeCommand<vscode.Uri>('mdRunbook.runAllAsCopy', uri), 60_000);
    assert.equal(path.dirname(copy2.fsPath), path.join(path.dirname(uri.fsPath), 'runs'));
    assert.match(read(copy2), /marker-content/);
    assert.equal(read(uri), src);
  } finally {
    await setConfig('output.copyFolder', undefined);
    await closeAll();
  }
});

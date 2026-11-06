/** Runbook links in VS Code (vscode://smojon.md-runbook/open?…): they open the runbook, fill its parameters, run nothing. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { formatVsCodeLink } from '@md-runbook/core/runbookLink';
import { LANG, Test, closeAll, outputText, runCells, waitFor, waitForRun } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

type Result = { kind: string; uri?: vscode.Uri; filled?: string[]; ignored?: string[]; message?: string };
const openLink = (link: string): Thenable<Result> => vscode.commands.executeCommand<Result>('mdRunbook._test.openLink', link);

test('links: a VS Code link opens the runbook it carries, with its parameters filled in, and runs nothing', async () => {
  const text = `# Restart\n\n\`\`\`${LANG}\necho "service=\${param:SERVICE}"\n\`\`\`\n`;
  try {
    const r = await openLink(formatVsCodeLink({ text, params: { SERVICE: 'api', OTHER: 'x' } }));
    assert.equal(r.kind, 'opened', JSON.stringify(r));
    assert.deepEqual(r.filled, ['SERVICE']);
    assert.deepEqual(r.ignored, ['OTHER'], 'a parameter the runbook does not use is reported, not set');
    const editor = await waitFor('the runbook editor', () => vscode.window.visibleNotebookEditors.find((e) => e.notebook.uri.toString() === r.uri?.toString()), 15_000);
    const cell = editor.notebook.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code)!;
    assert.equal(cell.executionSummary?.timing, undefined, 'nothing ran');
    // The value is used without asking.
    await runCells(editor, cell.index, cell.index + 1);
    assert.equal(await waitForRun(cell), true, outputText(cell));
    assert.match(outputText(cell), /service=api/);
  } finally {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await closeAll();
  }
});

test('links: a broken or http link is refused with the reason, and opens nothing', async () => {
  const before = vscode.workspace.notebookDocuments.length;
  const r = await openLink('vscode://smojon.md-runbook/open?url=http%3A%2F%2Fx.example.net%2Fr.md');
  assert.equal(r.kind, 'error');
  assert.match(r.message ?? '', /not https/);
  assert.equal(vscode.workspace.notebookDocuments.length, before);
});

/**
 * Setup and teardown in VS Code (core/parts.ts): Run All runs the ready check first, skips the
 * setup when it says up, and offers the teardown (answered here by a stubbed dialog).
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, openRunbook, outputText, read, runCells, step, waitFor, waitForRun, work, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';

/** The commands for a flag file: is it there, make it, remove it. */
function flagCommands(flag: string): { ready: string; up: string; down: string } {
  const f = flag.replace(/\\/g, '/');
  return LANG === 'pwsh'
    ? { ready: `if (-not (Test-Path "${f}")) { exit 1 }`, up: `New-Item -ItemType File -Force "${f}" | Out-Null`, down: `Remove-Item -Force "${f}"` }
    : { ready: `test -f "${f}"`, up: `touch "${f}"`, down: `rm -f "${f}"` };
}

/** Answer the teardown offer with `answer` (Take Down / Not Now), counting the times it is asked. */
function stubTeardown(answer: () => string): { asked: string[]; restore: () => void } {
  const w = vscode.window as unknown as { showInformationMessage: (...args: unknown[]) => Thenable<unknown> };
  const original = w.showInformationMessage;
  const asked: string[] = [];
  w.showInformationMessage = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('Run the teardown now')) {
      asked.push(message);
      return Promise.resolve(answer());
    }
    return original.call(vscode.window, message, ...rest);
  };
  return { asked, restore: () => void (w.showInformationMessage = original) };
}

/** A finished run's end time, to wait for the next one. */
const endOf = (cell: vscode.NotebookCell): number => cell.executionSummary?.timing?.endTime ?? 0;

test('Run All: the ready check skips a setup already up, and the teardown is offered (Not Now)', async () => {
  const flag = path.join(work, 'parts-lab.up');
  const c = flagCommands(flag);
  const uri = writeFile(
    'parts-guide.md',
    ['# Guide', '', fence(`${LANG} ready name="the lab"`, c.ready), '## 1. Start', '', fence(`${LANG} setup`, c.up), '## 2. Work', '', fence(LANG, 'echo work'), '## 3. Stop', '', fence(`${LANG} teardown name="Stop the lab"`, c.down)].join('\n'),
  );
  const stub = stubTeardown(() => 'Not Now');
  try {
    const editor = await openRunbook(uri);
    const cells = editor.notebook.getCells().filter((x) => x.kind === vscode.NotebookCellKind.Code);
    const [ready, setup, work1, teardown] = cells;

    await step('run all (cold)', runCells(editor, 0, editor.notebook.cellCount));
    assert.equal(await waitForRun(work1!, 60_000), true, outputText(work1!));
    await waitFor('the teardown offer', () => stub.asked.length === 1);
    assert.match(stub.asked[0]!, /Stop the lab/);
    assert.equal(ready!.executionSummary?.success, true, outputText(ready!));
    assert.equal(setup!.executionSummary?.success, true, outputText(setup!));
    assert.ok(fs.existsSync(flag), 'the setup ran');
    assert.equal(teardown!.outputs.length, 0, 'Not Now leaves the teardown as it was');

    const before = endOf(work1!);
    await step('run all (warm)', runCells(editor, 0, editor.notebook.cellCount));
    await waitFor('second run', () => endOf(work1!) > before, 60_000);
    assert.match(outputText(setup!), /already up \(the ready check passed\)/);
    assert.equal(stub.asked.length, 1, 'Not Now: not asked again for this runbook');
    assert.ok(fs.existsSync(flag), 'the teardown did not run');

    assert.ok(await step('save', editor.notebook.save()));
    const saved = read(uri);
    assert.match(saved, /check=ok [^\n]*ready=up/);
    assert.match(saved, /exit=skipped [^\n]*ready=up/);
  } finally {
    stub.restore();
    fs.rmSync(flag, { force: true });
    await closeAll();
  }
});

test('Run All: a setup call runs the ready check of the runbook it calls; Take Down runs the teardown call', async () => {
  const flag = path.join(work, 'parts-ka4.up');
  const c = flagCommands(flag);
  writeFile(
    'parts-ka4.md',
    ['# The lab (ka4)', '', fence(`${LANG} ready name="Lab answers"`, c.ready), '## Start the lab', '', fence(LANG, c.up), '## Stop the lab', '', fence(LANG, c.down)].join('\n'),
  );
  const uri = writeFile(
    'parts-caller.md',
    ['# Guide 3', '', fence('runbook src=parts-ka4.md section="Start the lab" setup', ''), fence(LANG, 'echo work'), fence('runbook src=parts-ka4.md section="Stop the lab" teardown', '')].join('\n'),
  );
  let answer = 'Not Now';
  const stub = stubTeardown(() => answer);
  try {
    const editor = await openRunbook(uri);
    const [setup, body] = editor.notebook.getCells().filter((x) => x.kind === vscode.NotebookCellKind.Code);

    await step('run all (cold)', runCells(editor, 0, editor.notebook.cellCount));
    assert.equal(await waitForRun(body!, 90_000), true, outputText(body!));
    assert.ok(fs.existsSync(flag), outputText(setup!));
    await waitFor('the teardown offer', () => stub.asked.length === 1);
    await closeAll();

    // A new window session would ask again; here Not Now holds, so run the teardown by hand.
    const editor2 = await openRunbook(uri);
    const [setup2, body2, teardown2] = editor2.notebook.getCells().filter((x) => x.kind === vscode.NotebookCellKind.Code);
    const before = endOf(body2!);
    await step('run all (warm)', runCells(editor2, 0, editor2.notebook.cellCount));
    await waitFor('second run', () => endOf(body2!) > before, 90_000);
    assert.match(outputText(setup2!), /already up: the ready check of parts-ka4\.md passed/);

    answer = 'Take Down';
    await step('run the teardown', runCells(editor2, teardown2!.index, teardown2!.index + 1));
    assert.equal(await waitForRun(teardown2!, 90_000), true, outputText(teardown2!));
    assert.equal(fs.existsSync(flag), false, 'the teardown call ran');
  } finally {
    stub.restore();
    fs.rmSync(flag, { force: true });
    await closeAll();
  }
});

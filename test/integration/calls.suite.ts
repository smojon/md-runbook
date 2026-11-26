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

/** Polls `fn` (async) until it gives a value. */
async function poll<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// A team's report: a risky command in a call's copy asked on the copy's cell, out of view,
// while the status bar and the Steps view followed the caller and the notice had no buttons.
test("a question in a call's copy: the status bar and the Steps view show it, the notice answers it", async () => {
  writeFile('call-child4.md', child('echo "B will apply"')); // `apply`: a risky command, it asks
  const uri = writeFile('call-parent4.md', parent('```runbook src=call-child4.md\nENV=dev\n```'));
  const editor = await openRunbook(uri);
  const call = editor.notebook.cellAt(2);
  // The run ends only once the question is answered: not awaited before.
  const running = runCells(editor, 2, 3);
  type Asked = { cell: string; what: string; answers: string[] };
  const asked = await poll('the question on the copy', async () =>
    ((await vscode.commands.executeCommand<Asked[]>('mdRunbook._waitingAnswers')) ?? []).find((q) => q.what === 'confirm second'),
  );
  assert.match(asked.cell, /call-child4\.\d{8}-\d{6}\.md/);
  // The caller stays in front; the surfaces that follow it show the copy's question.
  assert.equal(vscode.window.activeNotebookEditor?.notebook.uri.toString(), uri.toString());
  const item = await poll('the status bar item', async () => {
    const s = await vscode.commands.executeCommand<{ text: string; command?: string }>('mdRunbook._statusItem');
    return s?.text.includes('Waiting for you: confirm second') ? s : undefined;
  });
  assert.match(item.text, /^call-child4\.\d{8}-\d{6} · /);
  assert.equal(item.command, 'mdRunbook._revealCell');
  type Row = { kind: string; index?: number; state?: string; answers?: { id: string }[] };
  const m = (await vscode.commands.executeCommand<{ title: string; state: string; rows: Row[] }>('mdRunbook._steps'))!;
  assert.match(m.title, /^call-child4\.\d{8}-\d{6}\.md$/);
  assert.equal(m.state, 'waiting');
  assert.deepEqual(m.rows.find((r) => r.state === 'waiting')?.answers?.map((a) => a.id), ['run', 'no']);
  // The notice names the command and has the answers as buttons.
  type Notice = { text: string; buttons: string[] };
  const notices = await poll('the notice', async () => {
    const n = (await vscode.commands.executeCommand<Notice[]>('mdRunbook._waitingNotices')) ?? [];
    return n.some((x) => x.text.includes('call-child4')) ? n : undefined;
  });
  const at = notices.findIndex((x) => x.text.includes('call-child4'));
  assert.match(notices[at]!.text, /waits for you: Risky command in second .*“.*apply.*”/);
  assert.deepEqual(notices[at]!.buttons, ['Run', "Don't Run", 'Show the Step']);
  await step('Run, from the notice', vscode.commands.executeCommand('mdRunbook._pickWaitingNotice', at, 'Run'));
  await step('the run', running, 90_000);
  assert.equal(await waitForRun(call, 90_000), true, outputText(call));
  assert.match(plain(call), /✓ second/);
  // An old notice answers nothing (the question is gone).
  await vscode.commands.executeCommand('mdRunbook._pickWaitingNotice', at, "Don't Run");
  assert.equal(call.executionSummary?.success, true);
  await closeAll();
});

test('run again: a copy with planted "done" outputs is not continued, and its steps run', async () => {
  const body = child('echo "B ${param:ENV}"');
  writeFile('call-child3.md', body);
  // A run copy's name, next to it, the same blocks; its first step "done" by a planted output.
  const planted = 'call-child3.20261111-100000.md';
  writeFile(planted, body.replace('```\n\n## Part B', '```\n<!-- md-runbook:output start exit=0 -->\n```text\nplanted\n```\n<!-- md-runbook:output end -->\n\n## Part B'));
  // The caller's output (never signed) says the call failed in that copy.
  const failed = '<!-- md-runbook:output start exit=1 runbook=call-child3.md copy=' + planted + ' -->\n```text\nfailed\n```\n<!-- md-runbook:output end -->';
  const uri = writeFile('call-parent3.md', parent('```runbook src=call-child3.md\nENV=dev\n```\n' + failed));
  const editor = await openRunbook(uri);
  const call = editor.notebook.cellAt(2);
  await step('run the call', runCells(editor, 2, 3));
  assert.equal(await waitForRun(call, 90_000), true, outputText(call));
  const out = plain(call);
  assert.match(out, /not continuing call-child3\.20261111-100000\.md: its step results were not written by md-runbook on this machine/);
  assert.match(out, /running call-child3\.md as call-child3\.\d{8}-\d{6}\.md/);
  assert.match(out, /✓ first/);
  const fresh = copies('call-child3.md').find((c) => c !== planted)!;
  assert.match(fs.readFileSync(path.join(work, fresh), 'utf8'), /A dev/);
  await closeAll();
});

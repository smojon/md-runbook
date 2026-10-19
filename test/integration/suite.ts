/**
 * End-to-end tests inside a real VS Code: the serializer through VS Code's notebook model,
 * execution through the controller, and the commands. Run by ./index.ts.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type Test = { name: string; fn: () => Promise<void> };
export let trace: (line: string) => void = () => undefined;
export function setTrace(fn: (line: string) => void): void {
  trace = fn;
}

/** Fail with a clear message instead of hanging the whole run. */
export async function step<T>(what: string, p: Thenable<T>, ms = 30_000): Promise<T> {
  trace(`    … ${what}`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(p), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const EXT_ID = 'smojon.md-runbook';
export const isWin = process.platform === 'win32';
/** Shell used for execution tests: pwsh is the native Windows path, bash elsewhere. */
export const LANG = isWin ? 'pwsh' : 'bash';

export const FIXTURES = process.env.MD_RUNBOOK_FIXTURES ?? path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures');
export const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-itest-'));

export async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function writeFile(name: string, content: string | Uint8Array): vscode.Uri {
  const file = path.join(work, name);
  fs.writeFileSync(file, content);
  return vscode.Uri.file(file);
}

/**
 * Opens a file as a runbook and returns its editor. The open command's promise settles once VS
 * Code has set the notebook up (kernel included), so it waits for it too. On a busy macOS runner
 * that promise sometimes never settles although the editor opened, or no editor shows: then it
 * closes everything and opens once more (after 20 s, or 45 s without an editor). Slow opens are
 * logged.
 */
export async function openRunbook(uri: vscode.Uri): Promise<vscode.NotebookEditor> {
  const name = path.basename(uri.fsPath);
  const find = (): vscode.NotebookEditor | undefined =>
    [vscode.window.activeNotebookEditor, ...vscode.window.visibleNotebookEditors].find(
      (e) => e && e.notebook.uri.fsPath === uri.fsPath && e.notebook.notebookType === 'md-runbook',
    );
  const attempt = async (n: number): Promise<vscode.NotebookEditor> => {
    trace(`    … open ${name}${n > 1 ? ` (attempt ${n})` : ''}`);
    let failure: unknown;
    const settled = Promise.resolve(vscode.commands.executeCommand('mdRunbook.openAsRunbook', uri)).then(
      () => true,
      (e: unknown) => ((failure = e), true),
    );
    const started = Date.now();
    const editor = await waitFor(
      `runbook editor for ${name}`,
      () => {
        if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
        return find();
      },
      45_000,
    );
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([settled, new Promise<false>((r) => (timer = setTimeout(() => r(false), 20_000)))]);
    clearTimeout(timer);
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
    // Going on with such an editor left a cell that never ran (macOS, autosave.md): reopen once.
    if (!done && n === 1) throw new Error(`timed out: the open command for ${name} did not finish`);
    if (!done) trace(`    ! the open command for ${name} did not finish again; going on with its editor`);
    const ms = Date.now() - started;
    if (ms > 10_000) trace(`    ! opening ${name} took ${ms} ms`);
    return editor;
  };
  try {
    return await attempt(1).catch(async (e: Error) => {
      if (!/timed out/.test(e.message)) throw e;
      await closeAll();
      return attempt(2);
    });
  } catch (e) {
    const seen = vscode.window.visibleNotebookEditors.map((v) => `${v.notebook.notebookType} ${v.notebook.uri.toString()}`);
    const docs = vscode.workspace.notebookDocuments.map((d) => `${d.notebookType} ${d.uri.toString()}`);
    throw new Error(`${(e as Error).message}; wanted ${uri.toString()}; visible: [${seen.join(', ')}]; docs: [${docs.join(', ')}]`);
  }
}

export async function closeAll(): Promise<void> {
  await step('close editors', vscode.commands.executeCommand('workbench.action.closeAllEditors'));
}

/** Make the notebook dirty without changing its content, then save. */
export async function touchAndSave(nb: vscode.NotebookDocument): Promise<void> {
  const insert = new vscode.WorkspaceEdit();
  insert.set(nb.uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, 'tmp', 'markdown')])]);
  assert.ok(await step('insert cell', vscode.workspace.applyEdit(insert)));
  const remove = new vscode.WorkspaceEdit();
  remove.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(nb.cellCount - 1, nb.cellCount))]);
  assert.ok(await step('delete cell', vscode.workspace.applyEdit(remove)));
  assert.ok(nb.isDirty, 'notebook should be dirty');
  assert.ok(await step('save', nb.save()), 'save failed');
}

export async function selectKernel(editor: vscode.NotebookEditor): Promise<void> {
  await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: 'md-runbook-shell', extension: EXT_ID });
}

export async function runCells(editor: vscode.NotebookEditor, start: number, end: number): Promise<void> {
  await selectKernel(editor);
  await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start, end }], document: editor.notebook.uri });
}

export async function waitForRun(cell: vscode.NotebookCell, ms = 30_000): Promise<boolean | undefined> {
  await waitFor(`cell ${cell.index} to finish`, () => cell.executionSummary?.timing?.endTime !== undefined, ms);
  return cell.executionSummary?.success;
}

export function outputText(cell: vscode.NotebookCell): string {
  const dec = new TextDecoder();
  return cell.outputs.flatMap((o) => o.items.map((i) => dec.decode(i.data))).join('');
}

export const read = (uri: vscode.Uri): string => fs.readFileSync(uri.fsPath, 'utf8');

export async function setConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('mdRunbook').update(key, value, vscode.ConfigurationTarget.Global);
}

// ---------------------------------------------------------------------------------------------

test('extension activates', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, 'extension not installed');
  await ext.activate();
});

test('opening and saving every fixture is byte-identical', async () => {
  for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort()) {
    const original = fs.readFileSync(path.join(FIXTURES, name));
    const uri = writeFile('rt-' + name, original);
    const editor = await openRunbook(uri);
    await touchAndSave(editor.notebook);
    const saved = fs.readFileSync(uri.fsPath);
    assert.ok(saved.equals(original), `${name} changed on save:\n${JSON.stringify(saved.toString('utf8'))}`);
    await closeAll();
  }
});

test('markdown is markup, shell fences are code cells, outputs are outputs', async () => {
  const uri = writeFile('structure.md', fs.readFileSync(path.join(FIXTURES, 'outputs.md')));
  const nb = (await openRunbook(uri)).notebook;
  const code = nb.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
  assert.equal(code.length, 5);
  assert.equal(code[0]!.document.getText(), 'echo hello');
  assert.equal(code[0]!.document.languageId, 'shellscript');
  assert.match(outputText(code[0]!), /^hello/);
  assert.equal(code[3]!.document.languageId, 'powershell');
  await closeAll();
});

test('editing one cell rewrites only that block (CRLF file)', async () => {
  const src = '# Title\r\n\r\n```sh title=x\r\necho a\r\n```\r\n\r\nText  \r\n\r\n~~~pwsh\r\nGet-Date\r\n~~~\r\n';
  const uri = writeFile('edit.md', src);
  const nb = (await openRunbook(uri)).notebook;
  const cell = nb.getCells().find((c) => c.document.getText() === 'Get-Date')!;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(cell.document.uri, new vscode.Position(0, 8), '\nGet-Location');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(await step('save', nb.save()));
  assert.equal(read(uri), src.replace('Get-Date\r\n', 'Get-Date\r\nGet-Location\r\n'));
  await closeAll();
});

test(`running a ${LANG} cell streams output; save persists it redacted`, async () => {
  const body = isWin
    ? "Write-Output 'hello from md-runbook'\nWrite-Output 'Authorization: Bearer abc.def'\n(Get-Location).Path"
    : "echo 'hello from md-runbook'\necho 'Authorization: Bearer abc.def'\npwd";
  const uri = writeFile('run.md', `# Run\n\n\`\`\`${LANG}\n${body}\n\`\`\`\n\nAfter.\n`);
  const editor = await openRunbook(uri);
  const cell = editor.notebook.cellAt(1);
  await runCells(editor, 1, 2);
  assert.equal(await waitForRun(cell), true, outputText(cell));
  const live = outputText(cell);
  assert.match(live, /hello from md-runbook/);
  assert.match(live, /Authorization: \[REDACTED\]/, 'live view is redacted by default');
  assert.doesNotMatch(live, /abc\.def/);
  assert.match(live, /exit code 0/);
  assert.ok(await step('save', editor.notebook.save()));

  const saved = read(uri);
  const iso = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d';
  assert.match(saved, new RegExp('```\\n<!-- md-runbook:output start exit=0 ran=' + iso + ' ended=' + iso + ' duration=\\d+\\.\\d{3}s -->\\n```text\\n'));
  const block = saved.slice(saved.indexOf('<!-- md-runbook:output start'));
  assert.match(block, /hello from md-runbook\nAuthorization: \[REDACTED\]\n/);
  assert.doesNotMatch(block, /abc\.def/);
  // Windows: os.tmpdir() may be an 8.3 short path (RUNNER~1) and drive-letter case can differ.
  const norm = (p: string): string => (isWin ? p.toLowerCase() : p);
  const dirs = [work, fs.realpathSync(work), fs.realpathSync.native(work)].map(norm);
  assert.ok(dirs.some((d) => norm(block).includes(d)), `cwd should be the folder of the .md file (${dirs.join(' | ')})`);
  assert.match(saved, /<!-- md-runbook:output end -->\n\nAfter\.\n$/);
  assert.doesNotMatch(saved, /exit code 0/, 'status line is not persisted');
  await closeAll();

  // Reopen: the block comes back as the cell's output, not as a cell.
  const again = (await openRunbook(uri)).notebook;
  assert.equal(again.cellCount, 3);
  assert.match(outputText(again.cellAt(1)), /hello from md-runbook/);

  // Re-running replaces the block instead of adding another.
  const editor2 = vscode.window.activeNotebookEditor!;
  await runCells(editor2, 1, 2);
  await waitFor('re-run', () => /exit code 0 · /.test(outputText(again.cellAt(1))) && !again.cellAt(1).outputs.some((o) => o.metadata?.mdRunbook?.persisted));
  assert.ok(await step('save', again.save()));
  assert.equal(read(uri).match(/md-runbook:output start/g)?.length, 1);
  await closeAll();
});

test('run all stops at the first failure', async () => {
  const fail = isWin ? 'exit 3' : 'exit 3';
  const uri = writeFile('stop.md', `\`\`\`${LANG}\necho first\n\`\`\`\n\n\`\`\`${LANG}\n${fail}\n\`\`\`\n\n\`\`\`${LANG}\necho third\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  await selectKernel(editor);
  await vscode.commands.executeCommand('notebook.execute', editor.notebook.uri);
  const [c0, c1, c2] = editor.notebook.getCells();
  assert.equal(await waitForRun(c0!), true);
  assert.equal(await waitForRun(c1!), false);
  assert.match(outputText(c1!), /exit code 3/);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(c2!.outputs.length, 0, 'third cell must not run');
  assert.ok(await step('save', editor.notebook.save()));
  assert.match(read(uri), /exit=3/);
  assert.doesNotMatch(read(uri), /third\n```\n<!--/);
  await closeAll();
});

test('timeout kills the cell and is recorded', async () => {
  await setConfig('execution.timeoutSeconds', 1);
  try {
    const sleep = isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const uri = writeFile('timeout.md', `\`\`\`${LANG}\necho before\n${sleep}\n\`\`\`\n`);
    const editor = await openRunbook(uri);
    const started = Date.now();
    await runCells(editor, 0, 1);
    assert.equal(await waitForRun(editor.notebook.cellAt(0), 20_000), false);
    assert.ok(Date.now() - started < 15_000);
    assert.match(outputText(editor.notebook.cellAt(0)), /timed out/);
    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /exit=timeout/);
  } finally {
    await setConfig('execution.timeoutSeconds', undefined);
    await closeAll();
  }
});

test('cancel stops a running cell', async () => {
  const sleep = isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const uri = writeFile('cancel.md', `\`\`\`${LANG}\n${sleep}\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  // notebook.cell.execute resolves only when the run is over, so don't await it here.
  const running = runCells(editor, 0, 1);
  const cell = editor.notebook.cellAt(0);
  await waitFor('running', () => cell.outputs.length > 0);
  await new Promise((r) => setTimeout(r, 500));
  const started = Date.now();
  await step('cancel', vscode.commands.executeCommand('notebook.cancelExecution'));
  assert.equal(await waitForRun(cell, 15_000), false);
  assert.ok(Date.now() - started < 10_000, 'cancel took too long');
  await step('execute command', running);
  assert.match(outputText(cell), /cancelled/);
  await closeAll();
});

test('Clear All Outputs removes the blocks from the file', async () => {
  const src = fs.readFileSync(path.join(FIXTURES, 'outputs.md'), 'utf8');
  // Open as runbook.
  const uri = writeFile('clear.md', src);
  await openRunbook(uri);
  await vscode.commands.executeCommand('mdRunbook.clearAllOutputs', uri);
  await waitFor('save', () => !vscode.window.activeNotebookEditor?.notebook.isDirty);
  const cleared = read(uri);
  assert.equal(cleared.match(/md-runbook:output start/g)?.length, 2, 'only the orphan and malformed blocks remain');
  await closeAll();

  // Not open at all: the file is rewritten directly.
  const uri2 = writeFile('clear-closed.md', src.replace(/\n/g, '\r\n'));
  await vscode.commands.executeCommand('mdRunbook.clearAllOutputs', uri2);
  assert.equal(read(uri2), cleared.replace(/\n/g, '\r\n'));
});

test(`${isWin ? 'cmd' : 'sh'} blocks run`, async () => {
  const lang = isWin ? 'cmd' : 'sh';
  const uri = writeFile('other.md', `\`\`\`${lang}\necho other shell\n\`\`\`\n`);
  const editor = await openRunbook(uri);
  await runCells(editor, 0, 1);
  assert.equal(await waitForRun(editor.notebook.cellAt(0)), true, outputText(editor.notebook.cellAt(0)));
  assert.match(outputText(editor.notebook.cellAt(0)), /other shell/);
  await closeAll();
});

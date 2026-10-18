/** CodeLens runs from the plain text editor, and Export Report (HTML). */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, read, setConfig, step, trace, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

const SAMPLE =
  `# Lens\n\n\`\`\`${LANG}\necho one\n\`\`\`\n\nText.\n\n\`\`\`${LANG}\necho two\n\`\`\`\n` +
  '<!-- md-runbook:output start exit=1 ran=2026-10-18T14:20:00+02:00 duration=0.500s -->\n```text\nold\n```\n<!-- md-runbook:output end -->\n\n```json\n{}\n```\n';

async function openText(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await step('open text', vscode.workspace.openTextDocument(uri));
  await step('show text', vscode.window.showTextDocument(doc));
  return doc;
}

test('CodeLens shows Run / Run below and the last result above runnable blocks', async () => {
  const uri = writeFile('lens.md', SAMPLE);
  await openText(uri);
  // Off by default (text-editor runs skip the notebook's safety steps).
  const byDefault = await step('lenses (default)', vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 10));
  assert.equal(byDefault.filter((l) => l.command?.command.startsWith('mdRunbook.')).length, 0, 'CodeLens is off by default');
  await setConfig('codeLens.enabled', true);
  const all = await step('lenses', vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 10));
  const ours = all.filter((l) => l.command?.command.startsWith('mdRunbook.') || /exit/.test(l.command?.title ?? ''));
  const titles = ours.map((l) => `${l.range.start.line}:${l.command?.title}`);
  assert.ok(titles.includes('2:▶ Run'), titles.join(', '));
  assert.ok(titles.includes('2:▶ Run below'), titles.join(', '));
  assert.ok(titles.includes('8:▶ Run'), titles.join(', '));
  assert.ok(titles.some((t) => t.startsWith('8:✗ exit 1 · 0.5s')), titles.join(', '));
  assert.ok(!titles.some((t) => t.startsWith('17:')), 'json fence is not runnable');
  assert.deepEqual(ours.find((l) => l.command?.title === '▶ Run')?.command?.arguments?.[1], 1);

  await setConfig('codeLens.enabled', false);
  try {
    const none = await step('lenses off', vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 10));
    assert.equal(none.filter((l) => l.command?.command.startsWith('mdRunbook.')).length, 0);
  } finally {
    await setConfig('codeLens.enabled', undefined);
    await closeAll();
  }
});

test('running a block from the text editor writes its output block (unsaved)', async () => {
  const uri = writeFile('lens-run.md', SAMPLE);
  const doc = await openText(uri);
  await setConfig('codeLens.enabled', true);
  const ok = await step('run cell', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', uri, 1), 60_000);
  assert.equal(ok, true);
  const text = doc.getText();
  assert.match(text, /echo one\n```\n<!-- md-runbook:output start exit=0 ran=\S+ ended=\S+ duration=\d+\.\d{3}s -->\n```text\none\n```\n<!-- md-runbook:output end -->\n\nText\./);
  assert.match(text, /exit=1 ran=2026-10-18T14:20:00\+02:00 duration=0\.500s -->\n```text\nold\n/, 'other blocks untouched');
  assert.ok(doc.isDirty, 'document is not saved automatically');
  assert.equal(read(uri), SAMPLE);

  // Run below: both blocks run, the second block's old output is replaced.
  assert.equal(await step('run below', vscode.commands.executeCommand<boolean>('mdRunbook.runCellsBelowInEditor', uri, 1), 60_000), true);
  assert.equal(doc.getText().match(/md-runbook:output start exit=0/g)?.length, 2);
  assert.doesNotMatch(doc.getText(), /\nold\n/);
  await step('revert', vscode.commands.executeCommand('workbench.action.files.revert'));
  await closeAll();

  // Proposed (and assistant-written) cells never run from the text editor.
  const proposed = writeFile('lens-proposed.md', `\`\`\`${LANG} proposed by=ai reason="probe"\necho should-not-run\n\`\`\`\n`);
  const pdoc = await openText(proposed);
  try {
    assert.equal(await step('run proposed', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', proposed, 0), 60_000), false);
    assert.doesNotMatch(pdoc.getText(), /md-runbook:output start/);
  } finally {
    await setConfig('codeLens.enabled', undefined);
    await closeAll();
  }
});

test('text-editor runs honour skip, cwd= and timeout= and refuse ${param:} references', async () => {
  const src =
    `\`\`\`${LANG} skip\necho skipped-block\n\`\`\`\n\nA.\n\n` +
    `\`\`\`${LANG} cwd=does-not-exist\necho in-missing\n\`\`\`\n\nB.\n\n` +
    `\`\`\`${LANG} timeout=abc\necho bad-timeout\n\`\`\`\n\nC.\n\n` +
    `\`\`\`${LANG}\necho \${param:NAMESPACE}\n\`\`\`\n`;
  const uri = writeFile('lens-options.md', src);
  const doc = await openText(uri);
  await setConfig('codeLens.enabled', true);
  try {
    assert.equal(await step('run skip', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', uri, 0), 60_000), true);
    assert.equal(doc.getText(), src, 'a skipped block writes no output');
    assert.equal(await step('run cwd', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', uri, 2), 60_000), false);
    assert.match(doc.getText(), /Working directory not found: [^\n]*does-not-exist/);
    assert.equal(await step('run timeout', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', uri, 4), 60_000), false);
    assert.match(doc.getText(), /invalid cell option timeout=abc/);
    assert.doesNotMatch(doc.getText(), /\nbad-timeout\n/);
    const before = doc.getText();
    assert.equal(await step('run param', vscode.commands.executeCommand<boolean>('mdRunbook.runCellInEditor', uri, 6), 60_000), false);
    assert.equal(doc.getText(), before, 'a block with ${param:} references does not run');
    await step('revert', vscode.commands.executeCommand('workbench.action.files.revert'));
  } finally {
    await setConfig('codeLens.enabled', undefined);
    await closeAll();
  }
});

test('Export Report writes a self-contained HTML file with the step table', async () => {
  const uri = writeFile('lens-report.md', SAMPLE.replace('# Lens', '# Report <x>'));
  const out = await step('export', vscode.commands.executeCommand<vscode.Uri>('mdRunbook.exportReport', uri));
  assert.ok(out, 'no report uri returned');
  assert.equal(out.fsPath, uri.fsPath.replace(/\.md$/, '.report.html'));
  const html = fs.readFileSync(out.fsPath, 'utf8');
  assert.match(html, /<title>Report &lt;x&gt;<\/title>/);
  assert.match(html, /<table class="summary">/);
  assert.match(html, /<tr class="none"><td><a href="#step-1">1<\/a><\/td><td><code>echo one<\/code>/);
  assert.match(html, /<tr class="fail">.*✗ exit 1/);
  assert.doesNotMatch(html, /<script|src=|href="http/);
  await closeAll();
});

test('Export Report (PDF) prints the report with an installed Chrome or Edge', async () => {
  const { findBrowser } = await import('../../src/cli/pdf');
  if (!findBrowser(process.env.CHROME_PATH)) {
    trace('    … no Chrome, Edge or Chromium here: PDF export not tested');
    return;
  }
  const uri = writeFile('lens-pdf.md', SAMPLE);
  const out = await step('export pdf', vscode.commands.executeCommand<vscode.Uri>('mdRunbook.exportReportPdf', uri), 120_000);
  assert.ok(out, 'no PDF uri returned');
  assert.equal(out.fsPath, uri.fsPath.replace(/\.md$/, '.report.pdf'));
  assert.equal(fs.readFileSync(out.fsPath).subarray(0, 5).toString('latin1'), '%PDF-');
  await closeAll();
});

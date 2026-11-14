/** Agent-mode tools (src/ai/tools.ts), through their test command: no chat or model needed. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, openRunbook, read, setConfig, step, writeFile } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

// Step 1 done, step 2 failed (its saved output holds a token), step 3 still to do.
const SAMPLE =
  `# Deploy\n\n\`\`\`${LANG} name="Build"\necho build\n\`\`\`\n` +
  '<!-- md-runbook:output start exit=0 ran=2026-11-14T10:00:00+01:00 -->\n```text\nbuilt\n```\n<!-- md-runbook:output end -->\n\n' +
  `\`\`\`${LANG} name="Roll out"\necho rollout\n\`\`\`\n` +
  '<!-- md-runbook:output start exit=1 ran=2026-11-14T10:01:00+01:00 -->\n```text\nusing ghp_abcdefghijklmnopqrstuvwxyz0123456789\nerror: timed out\n```\n<!-- md-runbook:output end -->\n\n' +
  `\`\`\`${LANG} name="Smoke test"\necho smoke\n\`\`\`\n`;

type Answer = { text?: string; error?: string };
const tool = (name: string, input: unknown): Thenable<Answer> => vscode.commands.executeCommand<Answer>('mdRunbook._lmTool', name, input);

async function withAssistant(fn: () => Promise<void>): Promise<void> {
  await setConfig('ai.provider', 'vscode');
  try {
    await fn();
  } finally {
    await setConfig('ai.provider', undefined);
    await setConfig('approval.enabled', undefined);
  }
}

test('LM tools: refuse while the assistant is off', async () => {
  const uri = writeFile('lm-off.md', SAMPLE);
  await openRunbook(uri);
  const a = await step('runState', tool('md-runbook_runState', {}));
  assert.match(a.error ?? '', /assistant is off/);
  const b = await step('proposeStep', tool('md-runbook_proposeStep', { code: 'ls', reason: 'list' }));
  assert.match(b.error ?? '', /assistant is off/);
  await closeAll();
});

test('LM tools: runState lists the steps and the failed one, redacted', async () => {
  await withAssistant(async () => {
    const uri = writeFile('lm-state.md', SAMPLE);
    await openRunbook(uri);
    const a = await step('runState', tool('md-runbook_runState', { runbook: 'lm-state.md' }));
    assert.equal(a.error, undefined);
    const text = a.text ?? '';
    assert.match(text, /^Runbook: lm-state\.md/);
    assert.match(text, /^1\. Build: done/m);
    assert.match(text, /^2\. Roll out: failed/m);
    assert.match(text, /^3\. Smoke test: pending/m);
    assert.match(text, /^Failed step 2 \(Roll out\)/m);
    assert.match(text, /error: timed out/);
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'the token is redacted');
  });
  await closeAll();
});

test('LM tools: proposeStep adds a proposed cell after the failed step, and runs nothing', async () => {
  await withAssistant(async () => {
    const uri = writeFile('lm-propose.md', SAMPLE);
    const nb = (await openRunbook(uri)).notebook;
    const input = { code: 'kubectl get pods', language: 'bash', reason: 'list pods', name: 'Pods' };
    const q = await step('confirmation', vscode.commands.executeCommand<{ title: string; message: string } | undefined>('mdRunbook._lmToolConfirmation', input));
    assert.equal(q?.title, 'Add a proposed step to lm-propose.md after step 2?');
    assert.match(q?.message ?? '', /kubectl get pods/);
    const cells = nb.cellCount;
    const a = await step('proposeStep', tool('md-runbook_proposeStep', input));
    assert.equal(a.error, undefined);
    assert.match(a.text ?? '', /^Added a proposed step to lm-propose\.md after step 2; it is now step 3/);
    assert.match(a.text ?? '', /Nothing was run\./);
    assert.equal(nb.cellCount, cells + 1);
    const added = nb.getCells().find((c) => c.document.getText() === 'kubectl get pods');
    assert.ok(added, 'the proposed cell is in the runbook');
    assert.equal(added.outputs.length, 0, 'nothing is run');
    assert.ok(await step('save', nb.save()));
    assert.match(read(uri), /error: timed out\n```\n<!-- md-runbook:output end -->\n\n```bash proposed by=ai reason="list pods" name="Pods"\nkubectl get pods\n```\n/);
    // Approvals off: a proposal would run unapproved, so the tool adds none.
    await setConfig('approval.enabled', false);
    const b = await step('proposeStep, approvals off', tool('md-runbook_proposeStep', input));
    assert.match(b.error ?? '', /mdRunbook\.approval\.enabled is off/);
    assert.equal(nb.cellCount, cells + 1);
    // Input the model got wrong comes back as an error it can act on.
    await setConfig('approval.enabled', undefined);
    const c = await step('proposeStep, bad step', tool('md-runbook_proposeStep', { ...input, afterStep: 9 }));
    assert.match(c.error ?? '', /There is no step 9/);
  });
  await closeAll();
});

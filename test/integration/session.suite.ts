/** Persistent session mode end to end: state set in one cell is visible in the next. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LANG, Test, closeAll, isWin, openRunbook, outputText, runCells, setConfig, step, waitFor, waitForRun, work, writeFile } from './suite';

export const tests: Test[] = [
  {
    name: `session mode keeps environment variables between ${LANG} cells`,
    fn: async () => {
      await setConfig('execution.mode', 'session');
      try {
        const set = isWin ? "$env:FOO = 'bar'" : 'export FOO=bar';
        const get = isWin ? 'Write-Output "FOO=$env:FOO"' : 'echo "FOO=$FOO"';
        const uri = writeFile('session.md', `# Session\n\n\`\`\`${LANG}\n${set}\n\`\`\`\n\n\`\`\`${LANG}\n${get}\n\`\`\`\n`);
        const editor = await openRunbook(uri);
        const [first, second] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        await runCells(editor, 1, 3);
        assert.equal(await waitForRun(first), true, outputText(first));
        assert.equal(await waitForRun(second), true, outputText(second));
        assert.match(outputText(second), /FOO=bar/);
        assert.match(outputText(second), /session/, 'status line names the session');
        assert.doesNotMatch(outputText(first) + outputText(second), /__MDRB_/);

        // Stopping the session forgets the state.
        const stopped = await step('stop session', vscode.commands.executeCommand<string[]>('mdRunbook.stopSession', uri));
        // Windows: pwsh, or Windows PowerShell (labelled powershell) when PowerShell 7 is not installed.
        assert.equal(stopped?.length, 1, 'stop should find the running session');
        assert.match(stopped?.[0] ?? "", isWin ? /^(pwsh|powershell)$/ : /^bash$/);
        await runCells(editor, 2, 3);
        await waitFor('re-run in a new session', () => /FOO=\r?\n/.test(outputText(second)) && /exit code 0/.test(outputText(second))).catch((e: Error) => {
          throw new Error(`${e.message}; output: ${JSON.stringify(outputText(second))}`);
        });
      } finally {
        await setConfig('execution.mode', undefined);
        await closeAll();
      }
    },
  },
  {
    name: 'session mode: front matter turns it on, Toggle switches one runbook',
    fn: async () => {
      const set = isWin ? "$env:FOO = 'bar'" : 'export FOO=bar';
      const get = isWin ? 'Write-Output "FOO=$env:FOO"' : 'echo "FOO=$FOO"';
      const uri = writeFile('session-fm.md', `---\nmode: session\n---\n\n# FM\n\n\`\`\`${LANG}\n${set}\n\`\`\`\n\n\`\`\`${LANG}\n${get}\n\`\`\`\n`);
      try {
        const editor = await openRunbook(uri);
        type ModeInfo = { mode: string; source: string };
        const mode = (): Thenable<ModeInfo | undefined> => vscode.commands.executeCommand<ModeInfo>('mdRunbook._sessionMode', uri);
        assert.deepEqual(await mode(), { mode: 'session', source: 'front matter' });
        const [first, second] = [editor.notebook.cellAt(1), editor.notebook.cellAt(2)];
        await runCells(editor, 1, 3);
        assert.equal(await waitForRun(second), true, outputText(second));
        assert.match(outputText(second), /FOO=bar/);

        // Toggle off: this runbook now runs isolated, so FOO is not set any more.
        assert.equal(await step('toggle', vscode.commands.executeCommand('mdRunbook.toggleSessionMode', uri)), 'isolated');
        assert.deepEqual(await mode(), { mode: 'isolated', source: 'toggle' });
        await runCells(editor, 2, 3);
        await waitFor('isolated re-run', () => /FOO=\r?\n/.test(outputText(second)) && !/session/.test(outputText(second)));

        // Toggle back: the override is dropped because it equals the front matter.
        assert.equal(await step('toggle back', vscode.commands.executeCommand('mdRunbook.toggleSessionMode', uri)), 'session');
        assert.deepEqual(await mode(), { mode: 'session', source: 'front matter' });
        void first;
      } finally {
        await closeAll();
      }
    },
  },
  {
    name: 'session mode: cwd= applies to its own cell only',
    fn: async () => {
      await setConfig('execution.mode', 'session');
      try {
        fs.mkdirSync(path.join(work, 'session-cwd-sub'), { recursive: true });
        const where = isWin ? '"WHERE=$((Get-Location).Path)"' : 'echo "WHERE=$(pwd)"';
        const uri = writeFile('session-cwd.md', `\`\`\`${LANG} cwd=session-cwd-sub\n${where}\n\`\`\`\n\n\`\`\`${LANG}\n${where}\n\`\`\`\n`);
        const editor = await openRunbook(uri);
        const [first, second] = [editor.notebook.cellAt(0), editor.notebook.cellAt(1)];
        await runCells(editor, 0, 2);
        assert.equal(await waitForRun(first), true, outputText(first));
        assert.equal(await waitForRun(second), true, outputText(second));
        assert.match(outputText(first), /WHERE=.*session-cwd-sub/);
        assert.doesNotMatch(outputText(second), /session-cwd-sub/, 'the next cell runs in the runbook folder');
        assert.match(outputText(second), /session/);
      } finally {
        await setConfig('execution.mode', undefined);
        await closeAll();
      }
    },
  },
  {
    name: 'session mode: resetOnRunAll starts Run All in a fresh session',
    fn: async () => {
      await setConfig('execution.mode', 'session');
      await setConfig('session.resetOnRunAll', true);
      try {
        // Cell 1 prints FOO (from an earlier run) and then sets it; Run All must not see the old value.
        const body = isWin ? 'Write-Output "FOO=$env:FOO"\n$env:FOO = \'left-over\'' : 'echo "FOO=$FOO"\nexport FOO=left-over';
        const uri = writeFile('session-reset.md', `\`\`\`${LANG}\n${body}\n\`\`\`\n\n\`\`\`${LANG}\necho second\n\`\`\`\n`);
        const editor = await openRunbook(uri);
        const first = editor.notebook.cellAt(0);
        // A single-cell run keeps the session: the second run sees the value from the first.
        await runCells(editor, 0, 1);
        await runCells(editor, 0, 1);
        await waitFor('single re-run keeps state', () => /FOO=left-over/.test(outputText(first)));
        // Run All resets it.
        await step('run all', vscode.commands.executeCommand('notebook.execute', editor.notebook.uri));
        await waitFor('fresh session for Run All', () => /FOO=\r?\n/.test(outputText(first)) && /exit code 0/.test(outputText(first))).catch((e: Error) => {
          throw new Error(`${e.message}; output: ${JSON.stringify(outputText(first))}`);
        });
      } finally {
        await setConfig('session.resetOnRunAll', undefined);
        await setConfig('execution.mode', undefined);
        await closeAll();
      }
    },
  },
  {
    name: 'session mode: assistant-written cells run isolated, without the shared state',
    fn: async () => {
      await setConfig('execution.mode', 'session');
      // Let the file's approval stamp count, and give AI cells (required) read-only credentials.
      await setConfig('approval.trustFileApprovals', true);
      await setConfig('approval.readOnlyEnv', { MDRB_READONLY: 'yes' });
      try {
        const set = isWin ? "$env:FOO = 'bar'" : 'export FOO=bar';
        const get = isWin ? 'Write-Output "FOO=$env:FOO RO=$env:MDRB_READONLY"' : 'echo "FOO=$FOO RO=$MDRB_READONLY"';
        const uri = writeFile(
          'session-ai.md',
          `\`\`\`${LANG}\n${set}\n\`\`\`\n\n\`\`\`${LANG} approved-by=me approved-at=now by=ai reason="probe"\n${get}\n\`\`\`\n`,
        );
        const editor = await openRunbook(uri);
        const ai = editor.notebook.cellAt(1);
        await runCells(editor, 0, 2);
        assert.equal(await waitForRun(ai), true, outputText(ai));
        assert.match(outputText(ai), /FOO= RO=yes/, 'AI cell must not see FOO from the shared session, but gets read-only env');
        assert.doesNotMatch(outputText(ai), /session/, 'AI cell is not run in the session');
      } finally {
        await setConfig('approval.readOnlyEnv', undefined);
        await setConfig('approval.trustFileApprovals', undefined);
        await setConfig('execution.mode', undefined);
        await closeAll();
      }
    },
  },
];

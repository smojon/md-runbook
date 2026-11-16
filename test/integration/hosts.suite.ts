/**
 * Remote hosts (src/remoteHosts.ts) against the OpenSSH server CI starts for the SSH tests
 * (scripts/ci/start-sshd.sh): host= cells, Practice on a Host and Run on a Group in a real VS
 * Code. Skipped without MD_RUNBOOK_SSH_TEST=host:port:user, MD_RUNBOOK_SSH_HOST_PUB and
 * MD_RUNBOOK_SSH_AUTHORIZED_KEYS (Linux and macOS CI set them for this step).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { Test, closeAll, openRunbook, outputText, read, runCells, selectKernel, setConfig, step, waitForRun, writeFile } from './suite';

export const tests: Test[] = [];
const spec = process.env.MD_RUNBOOK_SSH_TEST;
const test = (name: string, fn: () => Promise<void>): void => void (spec && tests.push({ name, fn }));
const [host = '', port = '0', user = ''] = (spec ?? '').split(':');

const hook = (op: string, a?: unknown, b?: unknown): Thenable<unknown> => vscode.commands.executeCommand('mdRunbook._hostsTest', op, a, b);

/** Two names for the CI server (group ci), and one whose key isn't pinned (its address differs). */
async function setUp(): Promise<void> {
  const key = (await hook('publicKey')) as string;
  const keys = process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!;
  if (!fs.readFileSync(keys, 'utf8').includes(key)) fs.appendFileSync(keys, key + '\n');
  await hook('pin', `${host}:${port}`, fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
  await setConfig('hosts', [
    { name: 'ci', hostname: host, port: Number(port), user, group: 'ci' },
    { name: 'ci-b', hostname: host, port: Number(port), user, group: 'ci' },
    { name: 'ci-untrusted', hostname: 'localhost', port: Number(port), user, group: 'ci' },
  ]);
}

test('hosts: a host= cell runs on its host; the shell carries over; an unknown host is passed over', async () => {
  await setUp();
  try {
    const uri = writeFile(
      'hosts-run.md',
      '```bash host=ci\necho "remote $((2 + 3)) ${SSH_CONNECTION:+over-ssh}"\ncd /tmp\n```\n\n```bash host=ci\npwd\n```\n\n```bash host=nowhere\necho never\n```\n',
    );
    const editor = await openRunbook(uri);
    await hook('allow', editor.notebook.uri.toString(), 'ci');
    await selectKernel(editor);
    await runCells(editor, 0, 3);
    const [a, b, c] = editor.notebook.getCells();
    assert.equal(await waitForRun(a!, 60_000), true, outputText(a!));
    assert.match(outputText(a!), /remote 5 over-ssh/);
    assert.match(outputText(a!), /on ci/);
    assert.equal(await waitForRun(b!, 60_000), true, outputText(b!));
    assert.match(outputText(b!), /^(\/private)?\/tmp$/m);
    // Not one of the hosts: not run (cells run in order, so it has had its turn).
    assert.doesNotMatch(outputText(c!), /never/);
    assert.ok(await step('save', editor.notebook.save()));
    assert.match(read(uri), /remote 5/);
  } finally {
    await closeAll();
  }
});

test('hosts: an injected secret under a cell env= name stays on this machine', async () => {
  await setUp();
  await vscode.commands.executeCommand('mdRunbook._test.setSecret', 'MDRB_REMOTE_TOKEN', 'stored-secret-r3');
  await setConfig('secrets.inject', ['MDRB_REMOTE_TOKEN']);
  try {
    const uri = writeFile('hosts-env.md', '```bash host=ci env.MDRB_REMOTE_TOKEN=as-written\necho "token=$MDRB_REMOTE_TOKEN"\n```\n');
    const editor = await openRunbook(uri);
    await hook('allow', editor.notebook.uri.toString(), 'ci');
    await selectKernel(editor);
    await runCells(editor, 0, 1);
    const cell = editor.notebook.cellAt(0);
    assert.equal(await waitForRun(cell, 60_000), true, outputText(cell));
    assert.match(outputText(cell), /token=as-written/);
    assert.doesNotMatch(outputText(cell), /stored-secret-r3/);
  } finally {
    await setConfig('secrets.inject', undefined);
    await vscode.commands.executeCommand('mdRunbook._test.deleteSecret', 'MDRB_REMOTE_TOKEN');
    await closeAll();
  }
});

test('hosts: Practice on a Host sends every cell there, whatever host= says', async () => {
  await setUp();
  try {
    const uri = writeFile('hosts-practice.md', '```bash\necho "practice ${SSH_CONNECTION:+over-ssh}"\n```\n\n```bash host=nowhere\necho "also there ${SSH_CONNECTION:+over-ssh}"\n```\n');
    const editor = await openRunbook(uri);
    await selectKernel(editor);
    await vscode.commands.executeCommand('mdRunbook.practiceOnHost', 'ci');
    try {
      await runCells(editor, 0, 2);
      const [a, b] = editor.notebook.getCells();
      assert.equal(await waitForRun(a!, 60_000), true, outputText(a!));
      assert.match(outputText(a!), /practice over-ssh/);
      assert.equal(await waitForRun(b!, 60_000), true, outputText(b!));
      assert.match(outputText(b!), /also there over-ssh/);
    } finally {
      await vscode.commands.executeCommand('mdRunbook.practiceOnHost', '');
    }
  } finally {
    await closeAll();
  }
});

test('hosts: Run on a Group runs the cell on each host; an untrusted one is skipped', async () => {
  await setUp();
  try {
    const uri = writeFile('hosts-group.md', '```bash expect="group-ok"\necho group-ok\n```\n');
    const editor = await openRunbook(uri);
    await selectKernel(editor);
    const cell = editor.notebook.cellAt(0);
    await vscode.commands.executeCommand('mdRunbook.runOnGroup', cell, 'ci');
    // A skipped host fails the round.
    assert.equal(await waitForRun(cell, 90_000), false, outputText(cell));
    const out = outputText(cell);
    assert.match(out, /── ci \(/);
    assert.match(out, /── ci: exit 0 ──/);
    assert.match(out, /── ci-b: exit 0 ──/);
    assert.match(out, /── ci-untrusted: skipped ──/);
    assert.ok(await step('save', editor.notebook.save()));
    const saved = read(uri);
    assert.match(saved, /group=ci/);
    assert.match(saved, /hosts=ci,ci-b,ci-untrusted/);
    assert.match(saved, /failed=ci-untrusted/);
    assert.match(saved, /check=ok/);
  } finally {
    await setConfig('hosts', undefined);
    await closeAll();
  }
});

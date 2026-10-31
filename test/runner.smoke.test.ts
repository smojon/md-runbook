/**
 * Runs real shells. Each suite skips when its shell isn't installed. On Windows the pwsh and cmd
 * suites are the native-Windows smoke tests; set MD_RUNBOOK_PWSH / MD_RUNBOOK_BASH to point at a
 * specific executable.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ExecuteResult, ShellSettings, exitLabel } from '@md-runbook/core';
import { executeCell, nodeShellEnv, resolveShell, runProcess } from '@md-runbook/core/node';

const settings: ShellSettings = { pwshPath: process.env.MD_RUNBOOK_PWSH, bashPath: process.env.MD_RUNBOOK_BASH };
const isWin = process.platform === 'win32';
const has = (kind: 'bash' | 'pwsh' | 'cmd'): boolean => resolveShell(kind, settings, nodeShellEnv()).ok;

interface Run extends ExecuteResult {
  stdout: string;
  stderr: string;
}

async function run(language: string, source: string, extra: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const r = await executeCell({
    language,
    source,
    cwd: extra.cwd ?? process.cwd(),
    settings,
    timeoutMs: extra.timeoutMs ?? 60_000,
    signal: extra.signal,
    onStdout: (t) => (stdout += t),
    onStderr: (t) => (stderr += t),
  });
  return { ...r, stdout, stderr };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/** Run with the temp dir moved to a path containing spaces and a quote. */
async function withAwkwardTemp<T>(fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md runbook 'q' "));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = dir;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('pwsh smoke test', { skip: !has('pwsh') && 'PowerShell not found' }, () => {
  it('streams stdout and stderr and reports exit 0', async () => {
    const r = await run('pwsh', "Write-Output 'hello from pwsh'\n[Console]::Error.WriteLine('to stderr')\n$PSVersionTable.PSVersion.Major -ge 5");
    assert.equal(r.error, undefined);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /hello from pwsh/);
    assert.match(r.stdout, /True/);
    assert.match(r.stderr, /to stderr/);
  });

  it('propagates explicit exit codes and errors', async () => {
    assert.equal((await run('powershell', 'exit 5')).exitCode, 5);
    assert.equal((await run('pwsh', "throw 'boom'")).exitCode, 1);
    // Non-terminating errors follow PowerShell's rules: only fatal with ErrorActionPreference=Stop.
    assert.equal((await run('pwsh', "Write-Error 'bad'")).exitCode, 0);
    assert.equal((await run('pwsh', "$ErrorActionPreference = 'Stop'\nWrite-Error 'bad'\nWrite-Output unreachable")).exitCode, 1);
  });

  it('fails when the last native command fails', async () => {
    const native = isWin ? 'cmd /c exit 7' : 'sh -c "exit 7"';
    assert.equal((await run('pwsh', native)).exitCode, 7);
    assert.equal((await run('pwsh', `${native}\nWrite-Output ok`)).exitCode, 7);
  });

  it('runs in the given working directory and keeps UTF-8', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-cwd-'));
    const r = await run('pwsh', "(Get-Location).Path\nWrite-Output 'ünïcödé ✓ 日本'", { cwd });
    assert.equal(r.exitCode, 0, r.stderr);
    // .native expands Windows 8.3 short names (C:\Users\RUNNER~1) so both sides compare equal.
    assert.equal(fs.realpathSync.native(r.stdout.split(/\r?\n/)[0]!.trim()), fs.realpathSync.native(cwd));
    assert.match(r.stdout, /ünïcödé ✓ 日本/);
  });

  it('handles a temp path with spaces and quotes', async () => {
    const r = await withAwkwardTemp(() => run('pwsh', "Write-Output 'ok'"));
    assert.equal(r.exitCode, 0, r.stderr + (r.error ?? ''));
    assert.match(r.stdout, /ok/);
  });

  it('times out and kills the process tree', async () => {
    const child = isWin ? "Start-Process -NoNewWindow -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -PassThru" : "Start-Process -FilePath sleep -ArgumentList '60' -PassThru";
    const started = Date.now();
    const r = await run('pwsh', `$p = ${child}\nWrite-Output \"CHILD=$($p.Id)\"\nStart-Sleep -Seconds 60`, { timeoutMs: 3000 });
    assert.ok(r.timedOut);
    assert.equal(exitLabel(r), 'timeout');
    assert.ok(Date.now() - started < 20_000);
    const pid = Number(/CHILD=(\d+)/.exec(r.stdout)?.[1]);
    assert.ok(pid > 0, r.stdout + r.stderr);
    assert.ok(await waitDead(pid), `child ${pid} survived`);
  });
});

describe('cmd smoke test', { skip: !(isWin && has('cmd')) && 'cmd is Windows-only' }, () => {
  it('runs, echoes, and propagates exit codes', async () => {
    const r = await run('cmd', 'echo hello from cmd\r\necho %CD%\r\nexit /b 3');
    assert.equal(r.exitCode, 3, r.stderr);
    assert.match(r.stdout, /hello from cmd/);
    assert.doesNotMatch(r.stdout, /echo hello/);
  });

  it('handles a temp path with spaces', async () => {
    const r = await withAwkwardTemp(() => run('cmd', 'echo ok'));
    assert.equal(r.exitCode, 0, r.stderr + (r.error ?? ''));
    assert.match(r.stdout, /ok/);
  });

  it('cancel kills the tree', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const started = Date.now();
    const r = await run('cmd', 'ping -n 60 127.0.0.1 >nul', { signal: ac.signal });
    assert.ok(r.cancelled);
    assert.ok(Date.now() - started < 15_000);
  });
});

describe('bash smoke test', { skip: !has('bash') && 'bash not found' }, () => {
  it('streams output and reports exit codes', async () => {
    const r = await run('bash', 'echo out\necho err >&2\nexit 3');
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, 'out\n');
    assert.equal(r.stderr, 'err\n');
    assert.equal(exitLabel(r), '3');
  });

  it('sh blocks run too, in the working directory, with UTF-8', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-cwd-'));
    const r = await run('sh', 'pwd -P\necho "ünïcödé ✓"', { cwd });
    assert.equal(r.exitCode, 0, r.stderr);
    const [dir, text] = r.stdout.trim().split('\n');
    if (!isWin) assert.equal(dir, fs.realpathSync(cwd));
    assert.equal(text, 'ünïcödé ✓');
  });

  it('handles a temp path with spaces and quotes', async () => {
    const r = await withAwkwardTemp(() => run('bash', 'echo ok'));
    assert.equal(r.exitCode, 0, r.stderr + (r.error ?? ''));
  });

  it('timeout kills background children too', { skip: isWin && 'pid check is Unix-specific' }, async () => {
    const started = Date.now();
    const r = await run('bash', 'sleep 60 &\necho "CHILD=$!"\nsleep 60', { timeoutMs: 1500 });
    assert.ok(r.timedOut);
    assert.ok(Date.now() - started < 10_000);
    const pid = Number(/CHILD=(\d+)/.exec(r.stdout)?.[1]);
    assert.ok(await waitDead(pid), `background child ${pid} survived`);
  });

  it('cancel stops the run', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await run('bash', 'echo start\nsleep 60', { signal: ac.signal });
    assert.ok(r.cancelled);
    assert.equal(exitLabel(r), 'cancelled');
    assert.equal(r.stdout, 'start\n');
  });

  it('does not hang when the script leaves a daemon holding stdout', { skip: isWin && 'Unix-specific' }, async () => {
    const started = Date.now();
    const r = await run('bash', 'sleep 30 &\necho done');
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /done/);
    assert.ok(Date.now() - started < 10_000);
  });
});

describe('errors', () => {
  it('reports a missing working directory', async () => {
    const r = await run('bash', 'echo', { cwd: path.join(os.tmpdir(), 'does-not-exist-mdrb') });
    if (has('bash')) assert.equal(exitLabel(r), 'error');
  });

  it('reports unknown languages', async () => {
    const r = await run('python', 'print(1)');
    assert.match(r.error ?? '', /No shell/);
  });

  it('a run cancelled before it starts starts nothing', async () => {
    // A cancel while the cell is still being prepared: it threw a ReferenceError (onAbort used
    // before its declaration), which a slow machine hit in the cancel tests above.
    const ac = new AbortController();
    ac.abort();
    const r = await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("started")'],
      cwd: process.cwd(),
      timeoutMs: 0,
      signal: ac.signal,
      onStdout: () => assert.fail('the process started'),
      onStderr: () => {},
    });
    assert.ok(r.cancelled);
    assert.equal(r.exitCode, null);
  });
});

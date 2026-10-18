/** Persistent sessions with real shells; each suite skips when its shell isn't installed. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ExecuteResult, ShellSettings, exitLabel, nodeShellEnv, resolveShell } from '../src/core';
import { SentinelFilter, SessionPool } from '../src/core/session';

const settings: ShellSettings = { pwshPath: process.env.MD_RUNBOOK_PWSH, bashPath: process.env.MD_RUNBOOK_BASH };
const isWin = process.platform === 'win32';
const has = (kind: 'bash' | 'pwsh'): boolean => resolveShell(kind, settings, nodeShellEnv()).ok;

interface Run extends ExecuteResult {
  stdout: string;
  stderr: string;
}

function runner(pool: SessionPool, cwd = process.cwd()) {
  return async (language: string, source: string, extra: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<Run> => {
    let stdout = '';
    let stderr = '';
    const r = await pool.execute({
      language,
      source,
      cwd,
      settings,
      timeoutMs: extra.timeoutMs ?? 60_000,
      signal: extra.signal,
      env: extra.env,
      onStdout: (t) => (stdout += t),
      onStderr: (t) => (stderr += t),
    });
    return { ...r, stdout, stderr };
  };
}

describe('SentinelFilter', () => {
  const marker = '__MDRB_abc123__';
  const feed = (chunks: string[]): { out: string; code: number | undefined; emits: string[] } => {
    const emits: string[] = [];
    const f = new SentinelFilter(marker, (t) => emits.push(t));
    for (const c of chunks) f.write(c);
    return { out: emits.join(''), code: f.code, emits };
  };

  it('strips the sentinel and the newline before it', () => {
    assert.deepEqual(feed([`a\nb\n\n${marker} 3\n`]).out, 'a\nb\n');
    assert.equal(feed([`a\nb\n\n${marker} 3\n`]).code, 3);
    assert.equal(feed([`no newline\n${marker} 0\n`]).out, 'no newline');
    assert.equal(feed([`\n${marker} 0\r\n`]).out, '');
  });

  it('finds a sentinel split across chunks at every position', () => {
    const text = `line 1\nline 2\n\n${marker} 42\nafter`;
    for (let i = 1; i < text.length; i++) {
      for (let j = i; j < text.length; j++) {
        const r = feed([text.slice(0, i), text.slice(i, j), text.slice(j)]);
        assert.equal(r.out, 'line 1\nline 2\n', `split at ${i}/${j}`);
        assert.equal(r.code, 42);
      }
    }
  });

  it('holds back only a partial line that could be a sentinel', () => {
    assert.deepEqual(feed(['abc']).emits, ['abc']);
    assert.deepEqual(feed(['abc\ndef']).emits, ['abc\ndef']);
    assert.deepEqual(feed(['abc\n__MD']).emits, ['abc']);
    assert.deepEqual(feed(['abc\n__MDRB_zzz']).emits, ['abc\n__MDRB_zzz']);
  });

  it('passes through look-alikes with another id', () => {
    const fake = '\n__MDRB_ffffff__ 0\n';
    const r = feed([`x${fake}y\n${marker} 0\n`]);
    assert.equal(r.out, `x${fake}y`);
    assert.equal(r.code, 0);
  });
});

describe('bash session', { skip: !has('bash') && 'bash not found' }, () => {
  const pool = new SessionPool();
  const run = runner(pool);
  after(() => pool.dispose());

  it('keeps variables, functions and the working directory between cells', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-sess-'));
    assert.equal((await run('bash', `export FOO=bar\nlocal_var=42\ngreet() { echo "hi $1"; }\ncd '${dir.replace(/\\/g, '/')}'`)).exitCode, 0);
    const r = await run('sh', 'echo "$FOO $local_var"\ngreet you\npwd -P');
    assert.equal(r.exitCode, 0, r.stderr);
    const [vars, hi, cwd] = r.stdout.trim().split('\n');
    assert.equal(vars, 'bar 42');
    assert.equal(hi, 'hi you');
    if (!isWin) assert.equal(cwd, fs.realpathSync(dir));
  });

  it('reports each cell exit code; stdout and stderr are complete without sentinels', async () => {
    const r = await run('bash', 'echo out\necho err >&2\nprintf "no newline"\nfalse');
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, 'out\nno newline');
    assert.equal(r.stderr, 'err\n');
    assert.equal((await run('bash', 'true')).exitCode, 0);
    const big = await run('bash', 'for i in $(seq 1 20000); do echo "line $i"; done');
    assert.equal(big.stdout.split('\n').length, 20001);
    assert.doesNotMatch(big.stdout + big.stderr, /__MDRB_/);
  });

  it('runs multi-line cells with heredocs, and passes sentinel look-alikes through', async () => {
    const r = await run('bash', "f() {\n  cat <<EOF\nheredoc $1\nEOF\n}\nf one\necho '__MDRB_0123__ 0'\nprintf '\\n__MDRB_bad__ 5\\n' >&2");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'heredoc one\n__MDRB_0123__ 0\n');
    assert.equal(r.stderr, '\n__MDRB_bad__ 5\n');
  });

  it('a cell reading stdin gets end-of-file', async () => {
    const r = await run('bash', 'cat; echo "read done"');
    assert.equal(r.stdout, 'read done\n');
  });

  it('sets per-cell environment variables', async () => {
    const r = await run('bash', 'echo "$MDRB_X"', { env: { MDRB_X: "it's ü" } });
    assert.equal(r.stdout, "it's ü\n");
  });

  it('exit ends the session; the next cell starts a new one', async () => {
    await run('bash', 'KEEP=1');
    const r = await run('bash', 'echo bye\nexit 3');
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, 'bye\n');
    assert.match(r.stderr, /session ended \(exit 3\)/);
    assert.deepEqual(pool.labels(), []);
    const next = await run('bash', 'echo "KEEP=${KEEP:-unset}"');
    assert.equal(next.stdout, '[md-runbook] new session started\nKEEP=unset\n');
  });

  it('cancel kills the session tree; the next cell restarts it', async () => {
    const before = pool.session('bash')!.pid!;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const started = Date.now();
    const r = await run('bash', 'sleep 60 &\necho "CHILD=$!"\nsleep 60', { signal: ac.signal });
    assert.ok(r.cancelled);
    assert.equal(exitLabel(r), 'cancelled');
    assert.ok(Date.now() - started < 10_000);
    if (!isWin) {
      const child = Number(/CHILD=(\d+)/.exec(r.stdout)?.[1]);
      assert.ok(await waitDead(child), `background child ${child} survived`);
      assert.ok(await waitDead(before), `session ${before} survived`);
    }
    const next = await run('bash', 'echo again');
    assert.equal(next.exitCode, 0);
    assert.equal(next.stdout, '[md-runbook] new session started\nagain\n');
  });

  it('timeout kills the session', async () => {
    const r = await run('bash', 'sleep 60', { timeoutMs: 800 });
    assert.ok(r.timedOut);
    assert.equal(exitLabel(r), 'timeout');
    assert.equal((await run('bash', 'echo ok')).exitCode, 0);
  });

  it('restart and stop', async () => {
    await run('bash', 'X=1');
    assert.deepEqual(pool.restart(), [pool.labels()[0]]);
    assert.equal((await run('bash', 'echo "${X:-unset}"')).stdout, 'unset\n');
    assert.equal(pool.stop().length, 1);
    assert.deepEqual(pool.labels(), []);
  });
});

describe('pwsh session', { skip: !has('pwsh') && 'PowerShell not found' }, () => {
  const pool = new SessionPool();
  const run = runner(pool);
  after(() => pool.dispose());

  it('keeps variables, env vars, functions and location between cells', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-sess-'));
    const first = await run('pwsh', `$env:FOO = 'bar'\n$x = 42\nfunction Greet($n) { "hi $n" }\nSet-Location '${dir.replace(/'/g, "''")}'`);
    assert.equal(first.exitCode, 0, first.stderr);
    const r = await run('powershell', "\"$env:FOO $x\"\nGreet you\n(Get-Location).Path\nWrite-Output 'ünïcödé ✓'");
    assert.equal(r.exitCode, 0, r.stderr);
    const [vars, hi, cwd, text] = r.stdout.trim().split(/\r?\n/);
    assert.equal(vars, 'bar 42');
    assert.equal(hi, 'hi you');
    assert.equal(fs.realpathSync.native(cwd!.trim()), fs.realpathSync.native(dir));
    assert.equal(text, 'ünïcödé ✓');
  });

  it('exit codes follow isolated-mode rules', async () => {
    const native = isWin ? 'cmd /c exit 7' : 'sh -c "exit 7"';
    assert.equal((await run('pwsh', `${native}\nWrite-Output ok`)).exitCode, 7);
    assert.equal((await run('pwsh', "Write-Output 'fine'")).exitCode, 0);
    const thrown = await run('pwsh', "'before'\nthrow 'boom'\n'after'");
    assert.equal(thrown.exitCode, 1);
    assert.match(thrown.stdout, /before/);
    assert.doesNotMatch(thrown.stdout, /after/);
    assert.match(thrown.stderr, /boom/);
    assert.equal((await run('pwsh', "Write-Error 'nonterminating'\n'continues'")).exitCode, 0);
    assert.doesNotMatch(thrown.stdout + thrown.stderr, /__MDRB_/);
  });

  it('exit N ends the cell with N but keeps the session', async () => {
    await run('pwsh', '$keep = 1');
    const r = await run('pwsh', "'bye'\nexit 3");
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout.trim(), 'bye');
    assert.equal((await run('pwsh', '"keep=$keep"')).stdout.trim(), 'keep=1');
  });

  it('multi-line cells and per-cell env', async () => {
    const r = await run('pwsh', "function Add($a, $b) {\n  $a + $b\n}\n$h = @\"\nhere $(Add 1 2)\n\"@\n$h\n$env:MDRB_X", { env: { MDRB_X: "it's ü" } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['here 3', "it's ü"]);
    // Started with TERM=dumb; cells see the real value.
    assert.equal((await run('pwsh', '"[$env:TERM]"')).stdout.trim(), `[${process.env.TERM ?? ''}]`);
  });

  it('cancel kills the session; the next cell restarts it', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const r = await run('pwsh', "'start'\nStart-Sleep -Seconds 60", { signal: ac.signal });
    assert.ok(r.cancelled);
    const next = await run('pwsh', "'again'");
    assert.equal(next.exitCode, 0, next.stderr);
    assert.match(next.stdout, /^\[md-runbook\] new session started\r?\nagain/);
  });
});

describe('session pool fallbacks', () => {
  it('reports unknown languages like isolated mode', async () => {
    const pool = new SessionPool();
    const r = await runner(pool)('python', 'print(1)');
    assert.match(r.error ?? '', /No shell/);
    pool.dispose();
  });
});

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

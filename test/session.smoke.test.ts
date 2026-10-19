/** Persistent sessions with real shells; each suite skips when its shell isn't installed. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ExecuteOptions, ExecuteResult, ShellSettings, exitLabel } from '@md-runbook/core';
import { executeCell, nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { SENTINEL_START, SentinelFilter, SessionPool } from '@md-runbook/core/node/session';

const settings: ShellSettings = { pwshPath: process.env.MD_RUNBOOK_PWSH, bashPath: process.env.MD_RUNBOOK_BASH };
const isWin = process.platform === 'win32';
const has = (kind: 'bash' | 'pwsh'): boolean => resolveShell(kind, settings, nodeShellEnv()).ok;

interface Run extends ExecuteResult {
  stdout: string;
  stderr: string;
}

interface Extra {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** The cell's folder (a `cwd=` option); defaults to the base folder. */
  cwd?: string;
}

function runner(pool: SessionPool, cwd = process.cwd(), baseCwd?: string) {
  return async (language: string, source: string, extra: Extra = {}): Promise<Run> => {
    let stdout = '';
    let stderr = '';
    const r = await pool.execute({
      language,
      source,
      cwd: extra.cwd ?? cwd,
      baseCwd,
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
  const S = `${SENTINEL_START}${marker}`;
  const feed = (chunks: string[]): { out: string; code: number | undefined; emits: string[] } => {
    const emits: string[] = [];
    const f = new SentinelFilter(marker, (t) => emits.push(t));
    for (const c of chunks) f.write(c);
    return { out: emits.join(''), code: f.code, emits };
  };

  it('strips the sentinel and keeps the output exactly', () => {
    assert.deepEqual(feed([`a\nb\n${S} 3\n`]).out, 'a\nb\n');
    assert.equal(feed([`a\nb\n${S} 3\n`]).code, 3);
    assert.equal(feed([`no newline${S} 0\n`]).out, 'no newline');
    assert.equal(feed([`blank line\n\n${S} 0\n`]).out, 'blank line\n\n');
    assert.equal(feed([`${S} 0\r\n`]).out, '');
  });

  it('finds a sentinel split across chunks at every position', () => {
    const text = `line 1\nline 2\n${S} 42\nafter`;
    for (let i = 1; i < text.length; i++) {
      for (let j = i; j < text.length; j++) {
        const r = feed([text.slice(0, i), text.slice(i, j), text.slice(j)]);
        assert.equal(r.out, 'line 1\nline 2\n', `split at ${i}/${j}`);
        assert.equal(r.code, 42);
      }
    }
  });

  it('passes complete lines on at once, so the other stream cannot overtake their newline', () => {
    assert.deepEqual(feed(['failing native\n']).emits, ['failing native\n']);
    assert.deepEqual(feed(['a\n', '\n', `${S} 0\n`]), { out: 'a\n\n', code: 0, emits: ['a\n', '\n'] });
  });

  it('holds back only a tail that could be a sentinel', () => {
    assert.deepEqual(feed(['abc']).emits, ['abc']);
    assert.deepEqual(feed(['abc\ndef']).emits, ['abc\ndef']);
    assert.deepEqual(feed([`abc\n${SENTINEL_START}__MD`]).emits, ['abc\n']);
    assert.deepEqual(feed([`abc${SENTINEL_START}__MDRB_zzz`]).emits, [`abc${SENTINEL_START}__MDRB_zzz`]);
  });

  it('passes through look-alikes with another id', () => {
    const fake = `\n${SENTINEL_START}__MDRB_ffffff__ 0\n__MDRB_abc123__ 1\n`;
    const r = feed([`x${fake}y${S} 0\n`]);
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

/** A base folder (the runbook's folder) with subfolders whose names need quoting. */
function folders(): { base: string; other: string; plain: string } {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-base-')));
  const other = path.join(base, "other dir it's ’q’");
  const plain = path.join(base, 'plain');
  for (const d of [other, path.join(other, 'sub'), plain]) fs.mkdirSync(d);
  return { base, other, plain };
}

describe('bash session: cwd= cells, clean restart, setup file', { skip: !has('bash') && 'bash not found' }, () => {
  const { base, other, plain } = folders();
  const pool = new SessionPool();
  const run = runner(pool, base, base);
  after(() => pool.dispose());
  const lines = (r: Run): string[] => r.stdout.trim().split('\n');
  const pwd = async (extra?: Extra): Promise<string> => (await run('bash', 'pwd -P', extra)).stdout.trim();
  const same = (actual: string, expected: string): void => {
    if (!isWin) assert.equal(actual, expected); // Git Bash prints /c/... paths
  };

  it('a cell with its own folder runs there; the session stays where it was', async () => {
    same(await pwd(), base);
    const r = await run('bash', 'pwd -P\ncd sub\npwd -P', { cwd: other });
    assert.equal(r.exitCode, 0, r.stderr);
    if (!isWin) assert.deepEqual(lines(r), [other, path.join(other, 'sub')]);
    same(await pwd(), base);
    // A plain `cd` still carries over, and a cwd= cell comes back to it.
    assert.equal((await run('bash', 'cd plain')).exitCode, 0);
    same(await pwd(), plain);
    assert.equal((await run('bash', 'true', { cwd: other })).exitCode, 0);
    same(await pwd(), plain);
    assert.equal(pool.labels().length, 1);
  });

  it('a missing folder fails the cell, not the session (also with set -e)', async () => {
    await run('bash', 'set -e');
    const r = await run('bash', 'echo ran', { cwd: path.join(base, 'missing') });
    assert.notEqual(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /ran/);
    assert.equal(pool.labels().length, 1, 'session still running');
    await run('bash', 'set +e');
    same(await pwd(), plain);
  });

  it('removes the setup file (environment, folder) before the cell runs', async () => {
    const r = await run('bash', 'ls "$__mdrb_dir"; echo "$MDRB_S"', { env: { MDRB_S: 'x' }, cwd: other });
    assert.equal(r.exitCode, 0, r.stderr);
    const out = lines(r);
    assert.equal(out.pop(), 'x');
    assert.deepEqual(
      out.filter((f) => !/^[0-9a-f]{24}\.sh$/.test(f)),
      [],
      `only the cell script may be there: ${out.join(', ')}`,
    );
  });

  it('restart starts in the base folder with only the VS Code environment', async () => {
    pool.stop();
    // The cell that starts the session has its own folder and a secret.
    assert.equal((await run('bash', 'true', { cwd: other, env: { MDRB_SECRET: 's3cret' } })).exitCode, 0);
    pool.restart();
    const r = await run('bash', 'echo "${MDRB_SECRET:-unset}"\npwd -P');
    assert.equal(lines(r)[0], 'unset');
    same(lines(r)[1] ?? '', base);
  });
});

describe('pwsh session: cwd= cells, setup file, quoting', { skip: !has('pwsh') && 'PowerShell not found' }, () => {
  const { base, other, plain } = folders();
  const pool = new SessionPool();
  const run = runner(pool, base, base);
  after(() => pool.dispose());
  const real = (p: string): string => fs.realpathSync.native(p.trim());
  const loc = async (extra?: Extra): Promise<string> => real((await run('pwsh', '(Get-Location).Path', extra)).stdout);

  it('a cell with its own folder runs there; the session stays where it was', async () => {
    assert.equal(await loc(), base);
    const r = await run('pwsh', "(Get-Location).Path\nPush-Location sub\nSet-Location ..\nSet-Location sub\n(Get-Location).Path", { cwd: other });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/).map(real), [other, path.join(other, 'sub')]);
    assert.equal(await loc(), base);
    assert.equal((await run('pwsh', 'Set-Location plain')).exitCode, 0);
    assert.equal(await loc(), plain);
    assert.equal((await run('pwsh', "'x'", { cwd: other })).exitCode, 0);
    assert.equal(await loc(), plain);
  });

  it('a missing folder fails the cell, not the session', async () => {
    const r = await run('pwsh', "'ran'", { cwd: path.join(base, 'missing') });
    assert.equal(r.exitCode, 1);
    assert.doesNotMatch(r.stdout, /ran/);
    assert.equal(await loc(), plain);
    assert.equal(pool.labels().length, 1);
  });

  it('environment values with typographic quotes cannot break out', async () => {
    const value = "x’; Write-Output pwned; ’ ‘' ‚‛";
    const r = await run('pwsh', '$env:MDRB_X', { env: { MDRB_X: value } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.replace(/\r?\n$/, ''), value);
  });

  it('`$null | native` gives the command empty input (no BOM)', { skip: isWin && 'uses a POSIX cat' }, async () => {
    const r = await run('pwsh', "$null | cat\n'done'", { timeoutMs: 15_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout, 'done\n');
  });

  it('removes the setup file before the cell runs', async () => {
    const r = await run('pwsh', '(Get-ChildItem -Name $__mdrbDir) -join ","', { env: { MDRB_S: 'x' }, cwd: other });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout.trim(), /^[0-9a-f]{24}\.ps1$/);
  });

  it('restart starts in the base folder with only the VS Code environment', async () => {
    pool.stop();
    assert.equal((await run('pwsh', "'x'", { cwd: other, env: { MDRB_SECRET: 's3cret' } })).exitCode, 0);
    pool.restart();
    const r = await run('pwsh', 'if ($env:MDRB_SECRET) { $env:MDRB_SECRET } else { "unset" }\n(Get-Location).Path');
    const [secret, where] = r.stdout.trim().split(/\r?\n/);
    assert.equal(secret, 'unset');
    assert.equal(real(where ?? ''), base);
  });
});

describe('session output equals isolated output', () => {
  /** Both streams in the order they arrive, as the cell output shows them; colours removed. */
  async function combined(run: (o: ExecuteOptions) => Promise<ExecuteResult>, language: string, source: string): Promise<string> {
    let all = '';
    await run({ language, source, cwd: process.cwd(), settings, timeoutMs: 60_000, onStdout: (t) => (all += t), onStderr: (t) => (all += t) });
    return all.replace(/\x1b\[[0-9;]*m/g, '');
  }
  /**
   * Windows PowerShell 5.1 names the script file and quotes the line that ran it in each error.
   * Those differ by design (a temporary file, `&` vs. dot-sourcing), so blank them out there;
   * PowerShell 7's concise errors have neither and are compared exactly.
   */
  const r = resolveShell('pwsh', settings, nodeShellEnv());
  const windowsPowerShell = r.ok && r.shell.label === 'powershell';
  const comparable = (kind: 'bash' | 'pwsh', out: string): string =>
    kind === 'pwsh' && windowsPowerShell
      ? out
          .replace(/^.*?(?:cell|[0-9a-f]{24})\.ps1 : /gm, '<script> : ')
          .replace(/^At line:\d+ char:\d+\r?\n\+ .*\r?\n\+ *~+\r?\n/gm, '')
          .replace(/,(?:cell|[0-9a-f]{24})\.ps1(?=\r?$)/gm, ',<script>')
      : out;
  const pause = (kind: 'bash' | 'pwsh'): string => (kind === 'bash' ? 'sleep 0.3' : 'Start-Sleep -Milliseconds 300');
  const nativeFail = isWin ? 'cmd /c "echo oc: unknown command 1>&2 & exit 1"' : 'sh -c "echo oc: unknown command >&2; exit 1"';
  const cases: Array<{ kind: 'bash' | 'pwsh'; source: string; expected: string }> = [
    { kind: 'pwsh', source: `Write-Host "failing native"\n${pause('pwsh')}\n${nativeFail}`, expected: 'failing native\noc: unknown command\n' },
    { kind: 'pwsh', source: `Write-Error 'boom'\n${pause('pwsh')}\nWrite-Output 'after'`, expected: 'Write-Error: boom\nafter\n' },
    { kind: 'bash', source: `echo out\n${pause('bash')}\necho err >&2\n${pause('bash')}\necho out2`, expected: 'out\nerr\nout2\n' },
  ];
  for (const c of cases) {
    it(`${c.kind}: ${JSON.stringify(c.source.split('\n')[0])}`, { skip: !has(c.kind) && `${c.kind} not found` }, async () => {
      const pool = new SessionPool();
      try {
        const isolated = await combined((o) => executeCell(o), c.kind, c.source);
        const session = await combined((o) => pool.execute(o), c.kind, c.source);
        if (c.kind === 'bash' || !isWin) assert.equal(isolated.replace(/\r\n/g, '\n'), c.expected);
        assert.equal(comparable(c.kind, session), comparable(c.kind, isolated));
      } finally {
        pool.dispose();
      }
    });
  }
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

import { parse } from '@md-runbook/core';
import type { Host } from '../hosts/store';
import { runnability } from '../ssh/cells';
import { planLines } from '../ssh/lineRuns';
import { runCell } from '../ssh/runCell';
import { fakeConnection } from '../testing/fakeConnection';

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };
const runbook = [
  '# Deploy',
  '',
  '```bash expect=/ok/ timeout=5 env.A=1 cwd=/srv',
  'echo ok; echo warn >&2',
  '```',
  '',
  '```powershell',
  'Get-Date',
  '```',
  '',
  '```bash os=windows',
  'dir',
  '```',
  '',
  '```bash skip',
  'rm -rf /',
  '```',
  '',
  '```bash',
  'echo token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef',
  '```',
  '',
].join('\n');

describe('runCell', () => {
  it('runs a bash cell with its options and writes the output block the extension would', async () => {
    const conn = fakeConnection([{ stdout: 'ok\n', stderr: 'warn\n', exitCode: 0 }]);
    const live: string[] = [];
    const r = await runCell({ host, text: runbook, cellIndex: 1, connection: conn, onOutput: (t) => live.push(t) });
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    expect(conn.calls[0]).toMatchObject({ source: 'echo ok; echo warn >&2', opts: { timeoutMs: 5000, env: { A: '1' }, cwd: '/srv' } });
    expect(live.join('')).toBe('ok\nwarn\n');
    expect(r.attrs).toMatchObject({ exit: '0', check: 'ok' });
    expect(r.attrs.duration).toMatch(/^\d+\.\d{3}s$/);
    expect(r.summary).toMatch(/^✓ exit 0/);
    const cell = parse(r.text).cells[1];
    expect(cell?.output?.text).toBe('ok\nwarn');
    expect(cell?.output?.attrs.check).toBe('ok');
    // Everything else is untouched.
    expect(r.text.startsWith('# Deploy\n\n```bash expect=/ok/')).toBe(true);
    expect(r.text.endsWith('```\n')).toBe(true);
  });

  it('a failed check and a non-zero exit are written as such', async () => {
    const r = await runCell({ host, text: runbook, cellIndex: 1, connection: fakeConnection([{ stdout: 'nope\n', exitCode: 2 }]) });
    expect(r.kind === 'done' && r.attrs).toMatchObject({ exit: '2', check: 'failed' });
    expect(r.kind === 'done' && parse(r.text).cells[1]?.output?.text).toContain('[md-runbook] check failed:');
  });

  it('redacts secrets in the written output', async () => {
    const r = await runCell({
      host,
      text: runbook,
      cellIndex: 5,
      connection: fakeConnection([{ stdout: 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef\n' }]),
    });
    expect(r.kind === 'done' && parse(r.text).cells[5]?.output?.text).toBe('token=[REDACTED]');
  });

  it('asks for trust when the host key is unknown, nothing is written', async () => {
    const conn = fakeConnection([{ unknownHostKey: 'ecdsa-sha2-nistp256 AAAAE2 x' }]);
    conn.changed = true;
    const r = await runCell({ host, text: runbook, cellIndex: 1, connection: conn });
    expect(r).toEqual({ kind: 'trust', hostKey: 'ecdsa-sha2-nistp256 AAAAE2 x', changed: true });
  });

  it('reports connection errors and a new shell', async () => {
    expect(await runCell({ host, text: runbook, cellIndex: 1, connection: fakeConnection([{ error: 'connect ECONNREFUSED' }]) })).toEqual({
      kind: 'error',
      message: 'connect ECONNREFUSED',
    });
    const r = await runCell({ host, text: runbook, cellIndex: 1, connection: fakeConnection([{ stdout: 'ok\n', newShell: true }]) });
    expect(r.kind === 'done' && r.result.newShell).toBe(true);
  });

  it('refuses cells that cannot run over SSH', async () => {
    const cells = parse(runbook).cells;
    expect(runnability(cells[2]!)).toEqual({ ok: false, why: 'language' });
    expect(runnability(cells[3]!)).toEqual({ ok: false, why: 'os' });
    expect(runnability(cells[4]!)).toEqual({ ok: false, why: 'skip' });
    expect(runnability(cells[0]!)).toEqual({ ok: false, why: 'language' });
    expect(runnability(cells[1]!)).toMatchObject({ ok: true });
    const conn = fakeConnection();
    expect(await runCell({ host, text: runbook, cellIndex: 2, connection: conn })).toEqual({
      kind: 'error',
      message: 'Only bash and sh cells run over SSH',
    });
    expect(await runCell({ host, text: runbook, cellIndex: 42, connection: conn })).toMatchObject({ kind: 'error' });
    expect(conn.calls).toHaveLength(0);
  });

  it('a cancelled cell is written as cancelled', async () => {
    const ac = new AbortController();
    const p = runCell({ host, text: runbook, cellIndex: 1, connection: fakeConnection([{ waitForAbort: true }]), signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.kind === 'done' && r.attrs.exit).toBe('cancelled');
    expect(r.kind === 'done' && r.attrs.check).toBeUndefined();
  });
});

describe('line runs over SSH', () => {
  const text = ['# Steps', '', '```bash', 'cd /srv', 'make \\', '  build', 'echo done', '```', ''].join('\n');

  it('runs the chosen commands one by one, echoed, and writes lines=', async () => {
    const conn = fakeConnection([{ stdout: 'built\n' }, { stdout: 'done\n' }]);
    const steps: number[] = [];
    const r = await runCell({
      host,
      text,
      cellIndex: 1,
      connection: conn,
      lines: planLines(parse(text).cells[1]!.value, 'from', 1),
      onStep: (i) => steps.push(i ?? -1),
    });
    expect(conn.calls.map((c) => c.source)).toEqual(['make \\\n  build', 'echo done']);
    expect(steps).toEqual([0, 1, -1]);
    expect(r.kind === 'done' && r.attrs.lines).toBe('2-4');
    const out = r.kind === 'done' ? parse(r.text).cells[1]?.output : undefined;
    expect(out?.text).toBe('$ make \\\n    build\nbuilt\n$ echo done\ndone');
    expect(out?.attrs.lines).toBe('2-4');
  });

  it('stops at the first failing command and says so', async () => {
    const conn = fakeConnection([{ exitCode: 0 }, { stderr: 'no rule\n', exitCode: 2 }, { stdout: 'never\n' }]);
    const r = await runCell({ host, text, cellIndex: 1, connection: conn, lines: planLines(parse(text).cells[1]!.value, 'to', 3) });
    expect(conn.calls).toHaveLength(2);
    expect(r.kind === 'done' && r.attrs).toMatchObject({ exit: '2', lines: '1-3' });
  });

  it('every command of the cell is a full run: no lines=', async () => {
    const r = await runCell({
      host,
      text,
      cellIndex: 1,
      connection: fakeConnection([{}]),
      lines: planLines(parse(text).cells[1]!.value, 'to', 3),
    });
    expect(r.kind === 'done' && r.attrs.lines).toBeUndefined();
  });

  it('writes into the runbook as it is at the end of the run', async () => {
    const later = text.replace('# Steps', '# Steps\n\n- [x] ticked meanwhile');
    const r = await runCell({ host, text, cellIndex: 1, connection: fakeConnection([{ stdout: 'ok\n' }]), latestText: () => later });
    expect(r.kind === 'done' && r.text.includes('- [x] ticked meanwhile')).toBe(true);
    expect(r.kind === 'done' && parse(r.text).cells[1]?.output?.text).toBe('ok');
    const changed = text.replace('echo done', 'echo changed');
    expect(await runCell({ host, text, cellIndex: 1, connection: fakeConnection([{}]), latestText: () => changed })).toMatchObject({
      kind: 'error',
    });
  });
});

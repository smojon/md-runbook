import { parse } from '@md-runbook/core';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
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

describe('runCell: signed runbooks', () => {
  const plain = ['```bash', 'echo one', 'echo two', '```', '', '```bash', 'echo other', '```', ''].join('\n');
  const built = buildManifest(plain, { name: 'ops/x', version: 2, scopes: [], patterns: {} });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);
  const signed = withSignature(plain, { signer: 'ops@example.net', signed: '2026-10-22', manifest, signature: 'U1NIU0lH' });

  it('a signed cell goes to the session with its number in the manifest', async () => {
    const conn = fakeConnection([{ stdout: 'other\n' }]);
    await runCell({ host, text: signed, cellIndex: 1, connection: conn });
    expect(conn.calls[0]).toMatchObject({ source: 'echo other', signed: { manifest, signature: 'U1NIU0lH', cell: 2 } });
  });

  it('a line run sends each command as its signed step', async () => {
    const conn = fakeConnection([{}, {}]);
    await runCell({ host, text: signed, cellIndex: 0, connection: conn, lines: planLines('echo one\necho two', 'from', 1) });
    expect(conn.calls.map((c) => c.signed?.step)).toEqual([1]);
  });

  it('a cell changed since signing, or an unsigned runbook, goes as plain text', async () => {
    const conn = fakeConnection([{}, {}]);
    await runCell({ host, text: signed.replace('echo other', 'echo changed'), cellIndex: 1, connection: conn });
    await runCell({ host, text: plain, cellIndex: 1, connection: conn });
    expect(conn.calls.map((c) => c.signed)).toEqual([undefined, undefined]);
  });
});

describe('runCell: parameters', () => {
  const text = [
    '---',
    'params:',
    '  - REGION: eu-west-1',
    '---',
    '',
    '```bash',
    'echo "${param:TARGET} in ${param:REGION}"',
    'echo done',
    '```',
    '',
  ].join('\n');
  // Cells: front matter (markup), the bash cell.
  const cellIndex = 1;

  it('${param:NAME} runs as ${NAME} with the typed value, or the default, in the environment', async () => {
    const conn = fakeConnection([{}]);
    const r = await runCell({ host, text, cellIndex, connection: conn, params: { TARGET: 'web-1', REGION: '' } });
    expect(r.kind).toBe('done');
    expect(conn.calls[0]).toMatchObject({
      source: 'echo "${TARGET} in ${REGION}"\necho done',
      opts: { env: { TARGET: 'web-1', REGION: 'eu-west-1' } },
    });
  });

  it('a line run sends each command rewritten the same way', async () => {
    const conn = fakeConnection([{}]);
    const cell = parse(text).cells[cellIndex]!;
    await runCell({ host, text, cellIndex, connection: conn, params: { TARGET: 'x' }, lines: planLines(cell.value, 'at', 0) });
    expect(conn.calls[0]?.source).toBe('echo "${TARGET} in ${REGION}"');
  });

  it('a missing value, or a placeholder the app has no store for, stops before anything runs', async () => {
    const conn = fakeConnection([{}]);
    expect(await runCell({ host, text, cellIndex, connection: conn })).toEqual({
      kind: 'error',
      message: 'Enter a value for TARGET under Parameters',
    });
    const out = '```bash\necho ${out:POD}\n```\n';
    const r = await runCell({ host, text: out, cellIndex: 0, connection: conn });
    expect(r).toMatchObject({ kind: 'error', message: expect.stringMatching(/^\$\{out:POD\} is not supported in the app yet/) });
    expect(conn.calls).toHaveLength(0);
  });

  it('a signed runbook: values must match the signed pattern, and go to the gate with the run', async () => {
    const plain = '```bash\nsystemctl restart ${param:SERVICE}\n```\n';
    const built = buildManifest(plain, { name: 'ops/x', version: 1, scopes: [], patterns: { SERVICE: '[a-z-]+' } });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const signed = withSignature(plain, {
      signer: 'ops',
      signed: '2026-10-22',
      manifest: formatManifest(built.manifest),
      signature: 'U1NI',
    });
    const conn = fakeConnection([{}]);
    expect(await runCell({ host, text: signed, cellIndex: 0, connection: conn, params: { SERVICE: 'api; reboot' } })).toEqual({
      kind: 'error',
      message: "The value of SERVICE doesn't match its pattern [a-z-]+",
    });
    await runCell({ host, text: signed, cellIndex: 0, connection: conn, params: { SERVICE: 'api-gw' } });
    expect(conn.calls[0]).toMatchObject({ source: 'systemctl restart ${SERVICE}', signed: { cell: 1, params: { SERVICE: 'api-gw' } } });
  });
});

describe('runCell: secrets and inputs', () => {
  const text = '```bash\ncurl -H "Authorization: Bearer ${secret:API_TOKEN}" "https://${input:HOST}/"\n```\n';
  const stored: Record<string, string> = { API_TOKEN: 's3cr3t-token-value' };
  const readSecret = async (name: string): Promise<string | undefined> => stored[name];

  it('asks for what is missing: a secret not stored, an input not typed (masked when it looks secret)', async () => {
    const conn = fakeConnection([{}]);
    expect(await runCell({ host, text, cellIndex: 0, connection: conn, readSecret: async () => undefined })).toEqual({
      kind: 'needs',
      needs: [
        { kind: 'secret', name: 'API_TOKEN', masked: true },
        { kind: 'input', name: 'HOST', masked: false },
      ],
    });
    const pw = '```bash\necho ${input:DB_PASSWORD} ${input:PIN:secret}\n```\n';
    expect(await runCell({ host, text: pw, cellIndex: 0, connection: conn })).toMatchObject({
      needs: [
        { name: 'DB_PASSWORD', masked: true },
        { name: 'PIN', masked: true },
      ],
    });
    expect(conn.calls).toHaveLength(0);
  });

  it('values go in the environment, never in the script, and secrets are redacted live and in the file', async () => {
    const conn = fakeConnection([{ stdout: 'sent s3cr3t-token-value to api.example.net\n' }]);
    const live: string[] = [];
    const r = await runCell({
      host,
      text,
      cellIndex: 0,
      connection: conn,
      readSecret,
      inputs: { HOST: 'api.example.net' },
      onOutput: (t) => live.push(t),
    });
    expect(conn.calls[0]).toMatchObject({
      source: 'curl -H "Authorization: Bearer ${API_TOKEN}" "https://${HOST}/"',
      opts: { env: { API_TOKEN: 's3cr3t-token-value', HOST: 'api.example.net' } },
    });
    expect(live.join('')).toBe('sent [REDACTED] to api.example.net\n');
    expect(r.kind === 'done' && parse(r.text).cells[0]?.output?.text).toBe('sent [REDACTED] to api.example.net');
  });
});

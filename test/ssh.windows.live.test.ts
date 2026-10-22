/**
 * @md-runbook/ssh against a real OpenSSH server on Windows (cmd.exe as its default shell). CI
 * starts one (scripts/ci/start-sshd-windows.ps1) and sets the same variables as for
 * ssh.live.test.ts: MD_RUNBOOK_SSH_TEST=host:port:user, MD_RUNBOOK_SSH_HOST_PUB and
 * MD_RUNBOOK_SSH_AUTHORIZED_KEYS. Skipped without them, and on other systems.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { RemoteSession, RemoteShell, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const spec = process.platform === 'win32' ? process.env.MD_RUNBOOK_SSH_TEST : undefined;
const [host = '', port = '0', user = ''] = (spec ?? '').split(':');

describe('ssh: live Windows server', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST on Windows to run' }, () => {
  let key: KeyPair;
  let pinned: string;
  let shell: RemoteShell;
  const open = () => connectTcp(host, Number(port));
  const opts = () => ({ username: user, key, verifyHostKey: (k: string) => hostKeyId(k) === pinned });
  const collect = () => {
    const o = { out: '', err: '' };
    return { o, onStdout: (t: string) => (o.out += t), onStderr: (t: string) => (o.err += t) };
  };

  before(async () => {
    key = await generateKey();
    fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, (await publicKeyLine(key)) + '\n');
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
    shell = await RemoteShell.connect(await open(), opts());
  });
  after(() => shell?.close());

  it('finds Windows PowerShell after cmd.exe refused the sh command', () => {
    assert.equal(shell.platform, 'windows');
    assert.equal(shell.gate, undefined);
  });

  it('PowerShell cells keep variables and the folder; output is UTF-8', async () => {
    const a = collect();
    const one = await shell.run("$x = 'kept'; Set-Location $env:TEMP; 'Grüße ✓'", { shell: 'pwsh', ...a });
    assert.deepEqual([one.exitCode, a.o.out.replace(/\r\n/g, '\n')], [0, 'Grüße ✓\n']);
    const b = collect();
    const two = await shell.run('"$x in $((Get-Location).Path)"', { shell: 'pwsh', ...b });
    assert.equal(two.exitCode, 0);
    assert.match(b.o.out, /^kept in .*Temp\r?\n$/i);
  });

  it('cmd cells, exit codes, env values and a bash cell refused', async () => {
    const c = collect();
    const r = await shell.run('echo %MDRB_V%\nexit /b 3', { shell: 'cmd', env: { MDRB_V: 'from-env' }, ...c });
    assert.deepEqual([r.exitCode, c.o.out.trim()], [3, 'from-env']);
    const bash = await shell.run('uname', {});
    assert.match(bash.error ?? '', /Windows server: bash and sh cells need a Linux or macOS server/);
  });

  it('a cancelled native command stops; the shell goes on', async () => {
    const ac = new AbortController();
    const running = shell.run('ping -n 30 127.0.0.1 | Out-Null', { shell: 'pwsh', signal: ac.signal, stopGraceMs: 1000 });
    setTimeout(() => ac.abort(), 1500);
    const r = await running;
    assert.equal(r.cancelled, true);
    assert.ok(r.durationMs < 15_000, `${r.durationMs} ms`);
    const after = collect();
    assert.equal((await shell.run('"still here: $x"', { shell: 'pwsh', ...after })).exitCode, 0);
    assert.match(after.o.out, /still here: kept/);
  });

  it('a session reports the platform', async () => {
    const s = new RemoteSession(open, opts());
    try {
      await s.connect();
      assert.equal(s.platform, 'windows');
    } finally {
      await s.close();
    }
  });
});

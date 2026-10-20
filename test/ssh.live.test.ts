/**
 * @md-runbook/ssh against a real OpenSSH server. CI starts one (scripts/ci/start-sshd.sh) and sets
 * MD_RUNBOOK_SSH_TEST=host:port:user, MD_RUNBOOK_SSH_HOST_PUB (the server's host key file) and
 * MD_RUNBOOK_SSH_AUTHORIZED_KEYS (the test adds the key it makes). Skipped without them.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { ExternalKeyPair, RemoteSession, RemoteShell, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const spec = process.env.MD_RUNBOOK_SSH_TEST;
const [host = '', port = '0', user = ''] = (spec ?? '').split(':');

describe('ssh: live server', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST to run' }, () => {
  let key: KeyPair;
  let pinned: string;
  let shell: RemoteShell;
  const open = () => connectTcp(host, Number(port));
  const opts = () => ({ username: user, key, verifyHostKey: (k: string) => hostKeyId(k) === pinned });

  before(async () => {
    key = await generateKey();
    fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, (await publicKeyLine(key)) + '\n');
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
    shell = await RemoteShell.connect(await open(), opts());
  });
  after(() => shell?.close());

  it('a host key that does not match the pin is refused', async () => {
    await assert.rejects(RemoteShell.connect(await open(), { ...opts(), verifyHostKey: () => false }), /authentication failed/);
  });

  it('runs cells in one shell: state carries over, streams stay apart', async () => {
    let out = '';
    let err = '';
    const a = await shell.run('cd /tmp; X=kept; echo to-out; echo to-err >&2; exit_code=3; (exit $exit_code)', {
      onStdout: (t) => (out += t),
      onStderr: (t) => (err += t),
    });
    assert.equal(a.exitCode, 3);
    assert.equal(out, 'to-out\n');
    assert.equal(err, 'to-err\n');
    let b = '';
    await shell.run('echo "$X $PWD"', { onStdout: (t) => (b += t) });
    assert.match(b, /^kept (\/private)?\/tmp\n$/);
  });

  it('a large output arrives intact', async () => {
    let out = '';
    const r = await shell.run("head -c 1000000 /dev/zero | tr '\\0' 'x'; echo", { onStdout: (t) => (out += t) });
    assert.equal(r.exitCode, 0);
    assert.equal(out.length, 1_000_001);
  });

  it('a timeout stops the cell and keeps the shell', async () => {
    const started = Date.now();
    const r = await shell.run('sleep 30', { timeoutMs: 500 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    assert.equal(r.shellEnded, undefined);
    let b = '';
    await shell.run('echo "$X"', { onStdout: (t) => (b += t) });
    assert.equal(b, 'kept\n');
  });

  it('cancel (AbortSignal) stops the cell', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await shell.run('sleep 30; echo not-reached', { signal: ac.signal });
    assert.equal(r.cancelled, true);
    assert.equal(shell.isOpen, true);
  });

  it('a cell that ignores the signals: the shell is closed, the session opens a new one', async () => {
    const session = new RemoteSession(open, opts());
    await session.run('Y=old');
    const r = await session.run('while :; do :; done', { timeoutMs: 300, stopGraceMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.shellEnded, true);
    let b = '';
    const next = await session.run('echo "[$Y]"', { onStdout: (t) => (b += t) });
    assert.equal(next.newShell, true);
    assert.equal(b, '[]\n');
    await session.close();
  });

  it('`exit` in a cell ends the shell; the result says so', async () => {
    const s = await RemoteShell.connect(await open(), opts());
    const r = await s.run('exit 4');
    assert.equal(r.shellEnded, true);
    assert.equal(s.isOpen, false);
    await s.close();
  });

  it('latency per cell (logged, to compare with iOS)', async () => {
    const n = 20;
    const started = Date.now();
    for (let i = 0; i < n; i++) await shell.run('true');
    const ms = (Date.now() - started) / n;
    console.log(`ssh: ${ms.toFixed(1)} ms per cell`);
    assert.ok(ms < 500);
  });

  it('logs in with a key held outside JavaScript (as the phones keep theirs in hardware)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    let signed = 0;
    const external = await ExternalKeyPair.create({
      publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])),
      sign: async (data) => {
        signed++;
        return new Uint8Array(nodeSign('sha256', data, privateKey));
      },
    });
    fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, (await publicKeyLine(external, 'external')) + '\n');
    const hw = await RemoteShell.connect(await open(), { ...opts(), key: external });
    try {
      let out = '';
      const r = await hw.run('echo from-hardware-key', { onStdout: (t) => (out += t) });
      assert.equal(r.exitCode, 0);
      assert.equal(out, 'from-hardware-key\n');
      assert.equal(signed, 1);
    } finally {
      hw.close();
    }
  });
});

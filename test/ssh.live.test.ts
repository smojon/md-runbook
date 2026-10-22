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
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExternalKeyPair, RemoteSession, RemoteShell, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';
import { buildManifest, formatManifest } from '@md-runbook/core/signing';
import { sshSign } from '@md-runbook/core/node';

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

/**
 * Keys whose forced command is apps/gate/md-runbook-gate, as a server set up for signed runbooks
 * has them: the session finds the gate, hands it the signed manifest, runs cells by number and
 * cancels through the gate's stop request on a second channel.
 */
describe('ssh: through md-runbook-gate', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST to run' }, () => {
  const gate = path.resolve(__dirname, '..', '..', 'apps', 'gate', 'md-runbook-gate');
  let dir: string;
  let strict: KeyPair;
  let lenient: KeyPair;
  let pinned: string;
  const open = () => connectTcp(host, Number(port));
  const opts = (key: KeyPair) => ({ username: user, key, verifyHostKey: (k: string) => hostKeyId(k) === pinned });
  const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
  const RUNBOOK =
    fence('bash', 'cd /tmp; X=kept; echo "one $X"') +
    fence('bash', 'echo "two $X ${param:TARGET} $(basename "$PWD")"') +
    fence('bash', 'echo a\necho b') +
    fence('bash', 'sleep 30; echo not-reached') +
    fence('bash', 'exit 5');
  let manifest: string;
  let signature: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-gate-live-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ops@example.net', '-f', path.join(dir, 'signer')]);
    const pub = fs.readFileSync(path.join(dir, 'signer.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(path.join(dir, 'allowed_signers'), `ops@example.net namespaces="md-runbook" ${pub}\n`);
    fs.writeFileSync(path.join(dir, 'gate.conf'), `allowed_signers = ${path.join(dir, 'allowed_signers')}\nlog = ${path.join(dir, 'gate.log')}\n`);
    strict = await generateKey();
    lenient = await generateKey();
    const command = (extra: string) => `restrict,command="sh ${gate} --config=${path.join(dir, 'gate.conf')}${extra}"`;
    fs.appendFileSync(
      process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!,
      `${command('')} ${await publicKeyLine(strict)}\n${command(' --unsigned=allow --who=lenient')} ${await publicKeyLine(lenient)}\n`,
    );
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
    const built = buildManifest(RUNBOOK, { name: 'ops/live', version: 1, scopes: [], patterns: { TARGET: '[a-z]+' } });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    manifest = formatManifest(built.manifest);
    signature = await sshSign(manifest, path.join(dir, 'signer'));
  });

  it('finds the gate; an unsigned cell is refused with the reason', async () => {
    const s = await RemoteShell.connect(await open(), opts(strict));
    try {
      assert.deepEqual(s.gate, { protocol: 1, unsigned: 'refuse' });
      let err = '';
      const r = await s.run('echo should-not-run', { onStderr: (t) => (err += t) });
      assert.equal(r.exitCode, 126);
      assert.match(err, /runs signed runbooks only/);
    } finally {
      await s.close();
    }
  });

  it('runs signed cells by number, with state, parameters and commands in order', async () => {
    const session = new RemoteSession(open, opts(strict));
    try {
      let out = '';
      const onStdout = (t: string) => (out += t);
      const signed = { manifest, signature };
      const one = await session.run('ignored: the gate runs the signed code', { onStdout }, { ...signed, cell: 1 });
      assert.deepEqual([one.exitCode, one.signedBy, out], [0, 'ops@example.net', 'one kept\n']);
      out = '';
      let err = '';
      const noParam = await session.run('', { onStdout, onStderr: (t) => (err += t) }, { ...signed, cell: 2 });
      assert.equal(noParam.exitCode, 126);
      assert.match(err, /needs a value for the parameter TARGET/);
      const bad = await session.run('', { onStdout, onStderr: (t) => (err += t) }, { ...signed, cell: 2, params: { TARGET: 'a;b' } });
      assert.equal(bad.exitCode, 126);
      const two = await session.run('', { onStdout }, { ...signed, cell: 2, params: { TARGET: 'web' } });
      assert.deepEqual([two.exitCode, out], [0, 'two kept web tmp\n']);
      out = '';
      await session.run('', { onStdout }, { ...signed, cell: 3, step: 0 });
      await session.run('', { onStdout }, { ...signed, cell: 3, step: 1 });
      assert.equal(out, 'a\nb\n');
      assert.equal((await session.run('', {}, { ...signed, cell: 3, step: 1 })).exitCode, 126, 'not in order');
    } finally {
      await session.close();
    }
  });

  it('cancelling stops a signed cell through the gate; the shell stays', async () => {
    const session = new RemoteSession(open, opts(strict));
    try {
      const signed = { manifest, signature };
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 500);
      const r = await session.run('', { signal: ac.signal }, { ...signed, cell: 4 });
      assert.equal(r.cancelled, true);
      let out = '';
      const after = await session.run('', { onStdout: (t) => (out += t) }, { ...signed, cell: 1 });
      assert.deepEqual([after.exitCode, after.newShell, out], [0, undefined, 'one kept\n']);
      assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"stop"/);
    } finally {
      await session.close();
    }
  });

  it('after `exit` the session reconnects and hands the gate the runbook again', async () => {
    const session = new RemoteSession(open, opts(strict));
    try {
      const signed = { manifest, signature };
      const r = await session.run('', {}, { ...signed, cell: 5 });
      assert.equal(r.shellEnded, true);
      let out = '';
      const next = await session.run('', { onStdout: (t) => (out += t) }, { ...signed, cell: 1 });
      assert.deepEqual([next.exitCode, next.newShell, out], [0, true, 'one kept\n']);
    } finally {
      await session.close();
    }
  });

  it('a key with --unsigned=allow runs unsigned cells too', async () => {
    const session = new RemoteSession(open, opts(lenient));
    try {
      let out = '';
      const r = await session.run('echo "unsigned $((1 + 1))"', { onStdout: (t) => (out += t) });
      assert.deepEqual([r.exitCode, out], [0, 'unsigned 2\n']);
      assert.equal(session.gate?.unsigned, 'allow');
      assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"who":"lenient".*"event":"unsigned"/);
    } finally {
      await session.close();
    }
  });
});

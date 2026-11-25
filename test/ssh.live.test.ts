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
import { CertKeyPair, ExternalKeyPair, PasskeyKeyPair, RemoteSession, RemoteShell, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';
import { buildManifest, formatManifest } from '@md-runbook/core/signing';
import { sshSign } from '@md-runbook/core/node';
import { softPasskey } from './softPasskey';

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

  it("the runbook's shell: sh runs its cells (state carries over); zsh runs in zsh or says the server has none", async () => {
    const sh = await RemoteShell.connect(await open(), { ...opts(), shells: { unix: 'sh' } });
    try {
      let out = '';
      await sh.run('Y=kept');
      const r = await sh.run('echo "$Y"', { onStdout: (t) => (out += t) });
      assert.deepEqual([r.exitCode, out], [0, 'kept\n']);
    } finally {
      await sh.close();
    }
    let hasZsh = true;
    try {
      execFileSync('sh', ['-c', 'command -v zsh'], { stdio: 'ignore' });
    } catch {
      hasZsh = false;
    }
    const zsh = await RemoteShell.connect(await open(), { ...opts(), shells: { unix: 'zsh' } });
    try {
      let out = '';
      const r = await zsh.run('echo "${ZSH_VERSION:+zsh}"', { onStdout: (t) => (out += t) });
      if (hasZsh) assert.deepEqual([r.exitCode, out], [0, 'zsh\n']);
      else assert.match(r.error ?? '', /This server has no zsh \(the runbook's shell: zsh\)/);
    } finally {
      await zsh.close();
    }
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

  it('`exit` in a cell ends the shell; the result says so, with the exit code', async () => {
    const s = await RemoteShell.connect(await open(), opts());
    const r = await s.run('exit 4');
    assert.deepEqual([r.exitCode, r.error, r.shellEnded], [4, undefined, true]);
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

  it('logs in with a passkey (the web app), and verify-required refuses one used without the user', async () => {
    const rp = 'runbook.example.net';
    const passkey = softPasskey(rp);
    const key = new PasskeyKeyPair(passkey);
    // A second passkey whose authenticator cannot verify the user (UP only, as a security key without PIN).
    const unverified = new PasskeyKeyPair(softPasskey(rp, { flags: 0x01 }));
    for (const k of [key, unverified]) {
      fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, `verify-required ${await publicKeyLine(k, 'passkey')}\n`);
    }
    const web = await RemoteShell.connect(await open(), { ...opts(), key });
    try {
      let out = '';
      const r = await web.run('echo from-passkey', { onStdout: (t) => (out += t) });
      assert.equal(r.exitCode, 0);
      assert.equal(out, 'from-passkey\n');
      assert.equal(passkey.signed, 1);
    } finally {
      web.close();
    }
    await assert.rejects(RemoteShell.connect(await open(), { ...opts(), key: unverified }), /authentication failed/);
  });
});

/**
 * Keys whose forced command is md-runbook-gate (the binary MD_RUNBOOK_GATE_BIN names, by default
 * apps/gate/dist/md-runbook-gate), as a server set up for signed runbooks has them: the session
 * finds the gate, hands it the signed manifest, runs cells by number and cancels through the
 * gate's stop request on a second channel.
 */
describe('ssh: through md-runbook-gate', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST to run' }, () => {
  const gate = path.resolve(process.env.MD_RUNBOOK_GATE_BIN || path.join(__dirname, '..', '..', 'apps', 'gate', 'dist', 'md-runbook-gate'));
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
    strict = await generateKey();
    lenient = await generateKey();
    // All signed or none per account: CI's one account has both keys (and its own), so each key's
    // config names a key file with only its own line, as two accounts would have.
    // A key line's --config= must be a file the account can't change (security review round 4):
    // root's, in a folder of root's, as on a server (CI has sudo).
    const confDir = path.join(dir, 'root');
    execFileSync('sudo', ['-n', 'install', '-d', '-m', '755', '-o', 'root', confDir]);
    const line = async (name: string, extra: string, k: KeyPair): Promise<string> =>
      `restrict,command="${gate} --config=${path.join(confDir, `${name}.conf`)}${extra}" ${await publicKeyLine(k)}`;
    const lines = { strict: await line('strict', '', strict), lenient: await line('lenient', ' --unsigned=allow --who=lenient', lenient) };
    for (const [name, l] of Object.entries(lines)) {
      fs.writeFileSync(path.join(dir, `${name}.keys`), l + '\n');
      // CI's account has bash as its login shell, which the gate refuses under sshd (~/.bashrc
      // runs first): login_shell_check = no, as for any test server with such accounts.
      fs.writeFileSync(
        path.join(dir, `${name}.conf`),
        `allowed_signers = ${path.join(dir, 'allowed_signers')}\nlog = ${path.join(dir, 'gate.log')}\nauthorized_keys = ${path.join(dir, `${name}.keys`)}\nlogin_shell_check = no\n`,
      );
      execFileSync('sudo', ['-n', 'install', '-m', '644', '-o', 'root', path.join(dir, `${name}.conf`), path.join(confDir, `${name}.conf`)]);
    }
    fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, `${lines.strict}\n${lines.lenient}\n`);
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
    const built = buildManifest(RUNBOOK, { name: 'ops/live', version: 1, scopes: [], patterns: { TARGET: '[a-z]+' } });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    manifest = formatManifest(built.manifest);
    signature = await sshSign(manifest, path.join(dir, 'signer'));
  });

  it('finds the gate; an unsigned cell is refused with the reason', async () => {
    const s = await RemoteShell.connect(await open(), opts(strict));
    try {
      assert.deepEqual(s.gate, { protocol: 4, unsigned: 'refuse' });
      let err = '';
      const r = await s.run('echo should-not-run', { onStderr: (t) => (err += t) });
      assert.equal(r.exitCode, 126);
      assert.match(err, /runs signed runbooks only/);
      // The kube-context check is answered all the same (kubectl's own exit: 0, 1 without a
      // kubeconfig, 127 where it isn't installed), never refused.
      const ctx = await s.kubeContext();
      assert.notEqual(ctx.exitCode, 126);
      assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"context"/);
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

  it('a run with an alert: the gate logs the alert with the load (protocol 3), and it changes nothing else', async () => {
    const session = new RemoteSession(open, opts(strict));
    try {
      let out = '';
      const alert = { name: 'LiveAlert', fingerprint: 'f00d:1', startsAt: '2026-11-14T08:58:00Z' };
      const one = await session.run('', { onStdout: (t) => (out += t) }, { manifest, signature, cell: 1, alert });
      assert.deepEqual([one.exitCode, out], [0, 'one kept\n']);
      const loads = fs
        .readFileSync(path.join(dir, 'gate.log'), 'utf8')
        .split('\n')
        .filter((l) => /"event":"load"/.test(l) && l.includes('LiveAlert'));
      assert.equal(loads.length, 1);
      assert.match(loads[0]!, /"alert":"LiveAlert","alert-fingerprint":"f00d:1","alert-starts-at":"2026-11-14T08:58:00Z"/);
    } finally {
      await session.close();
    }
  });

  it('cancelling stops a signed cell through the gate; the shell stays', async () => {
    const session = new RemoteSession(open, opts(strict));
    try {
      const signed = { manifest, signature };
      // Connected and loaded first, so the cancel below lands while the cell runs.
      assert.equal((await session.run('', {}, { ...signed, cell: 1 })).exitCode, 0);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 1000);
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

// VS Code logs in with the keys of the user's SSH agent (packages/ssh/src/agent.ts): a real
// ssh-agent with Ed25519 and RSA keys made by ssh-keygen, against the same server.
describe('ssh: live server, agent keys', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST to run' }, () => {
  let dir: string;
  let sock: string;
  let agentProcess: import('node:child_process').ChildProcess | undefined;
  let pinned: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-agent-'));
    sock = path.join(dir, 'agent.sock');
    const { spawn } = await import('node:child_process');
    agentProcess = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    for (const type of ['ed25519', 'rsa']) {
      const file = path.join(dir, `id_${type}`);
      execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', `agent-${type}`, '-f', file]);
      execFileSync('ssh-add', [file], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
      fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, fs.readFileSync(`${file}.pub`, 'utf8'));
    }
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
  });
  after(() => agentProcess?.kill());

  it('logs in with each agent key and runs a cell', async () => {
    const { agentAlgorithms, agentKeys } = await import('@md-runbook/ssh/node');
    const keys = await agentKeys(sock);
    assert.deepEqual(
      keys.map((k) => k.keyAlgorithmName).sort(),
      ['ssh-ed25519', 'ssh-rsa'],
    );
    for (const key of keys) {
      const session = new RemoteSession(() => connectTcp(host, Number(port)), {
        username: user,
        key,
        configure: agentAlgorithms,
        verifyHostKey: (k: string) => hostKeyId(k) === pinned,
      });
      try {
        let out = '';
        const r = await session.run('echo "agent $((2 + 3))"', { onStdout: (t) => (out += t) });
        assert.deepEqual([r.exitCode, out], [0, 'agent 5\n'], key.keyAlgorithmName);
      } finally {
        await session.close();
      }
    }
  });

  it('a key the server does not know, then a known one: the second logs in', async () => {
    const { agentAlgorithms, agentKeys } = await import('@md-runbook/ssh/node');
    const [first, ...rest] = await agentKeys(sock);
    const stranger = await generateKey();
    const session = new RemoteSession(() => connectTcp(host, Number(port)), {
      username: user,
      key: stranger,
      moreKeys: [first!, ...rest],
      configure: agentAlgorithms,
      verifyHostKey: (k: string) => hostKeyId(k) === pinned,
    });
    try {
      const r = await session.run('true');
      assert.equal(r.exitCode, 0);
    } finally {
      await session.close();
    }
  });
});

// OpenSSH user certificates: sshd trusts a CA (TrustedUserCAKeys, scripts/ci/start-sshd.sh); the
// keys below are in no authorized_keys, so only their certificates can log them in.
describe('ssh: live server, certificates', { skip: !spec && 'set MD_RUNBOOK_SSH_TEST to run' }, () => {
  let dir: string;
  let pinned: string;
  let userCa: string;
  /** ssh-keygen -s `ca` … on `pubLine`: the -cert.pub line. */
  const certify = (pubLine: string, name: string, args: string[], ca = userCa): string => {
    const file = path.join(dir, `${name}.pub`);
    fs.writeFileSync(file, `${pubLine}\n`);
    execFileSync('ssh-keygen', ['-q', '-s', ca, '-I', name, ...args, file]);
    return fs.readFileSync(path.join(dir, `${name}-cert.pub`), 'utf8').trim();
  };
  const session = (key: KeyPair, more: Partial<import('@md-runbook/ssh').ConnectOptions> = {}) =>
    new RemoteSession(() => connectTcp(host, Number(port)), { username: user, key, verifyHostKey: (k: string) => hostKeyId(k) === pinned, ...more });
  const echo = async (s: RemoteSession, text: string): Promise<void> => {
    let out = '';
    const r = await s.run(`echo ${text}`, { onStdout: (t) => (out += t) });
    assert.deepEqual([r.exitCode, out], [0, `${text}\n`]);
  };
  /** An ssh-agent of its own, with these keys (made here) and the -cert.pub files `prepare` writes next to them. */
  const withAgent = async (
    name: string,
    keys: { file: string; type: string; bits?: string[] }[],
    prepare: (file: string) => void,
    body: (sock: string) => Promise<void>,
  ): Promise<void> => {
    const sock = path.join(dir, `${name}.sock`);
    const { spawn } = await import('node:child_process');
    const agentProcess = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
      for (const k of keys) {
        const file = path.join(dir, k.file);
        execFileSync('ssh-keygen', ['-q', '-t', k.type, ...(k.bits ?? []), '-N', '', '-C', k.file, '-f', file]);
        prepare(file);
        // ssh-add loads id-cert.pub next to the key too.
        execFileSync('ssh-add', [file], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
      }
      await body(sock);
    } finally {
      agentProcess.kill();
    }
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-certs-'));
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
    userCa = path.join(path.dirname(process.env.MD_RUNBOOK_SSH_HOST_PUB!), 'user_ca');
    assert.ok(fs.existsSync(userCa), `no ${userCa}: scripts/ci/start-sshd.sh makes the user CA next to the host key`);
  });

  it("md-runbook's own key with a certificate logs in; without it, it doesn't", async () => {
    const key = await generateKey();
    const cert = certify(await publicKeyLine(key), 'own', ['-n', user, '-V', '-5m:+1h']);
    const s = session(await CertKeyPair.create(key, cert));
    try {
      await echo(s, 'cert-own');
    } finally {
      await s.close();
    }
    await assert.rejects(RemoteShell.connect(await connectTcp(host, Number(port)), { username: user, key, verifyHostKey: (k) => hostKeyId(k) === pinned }), /authentication failed/);
  });

  it('a hardware key (signs outside JavaScript) with a certificate logs in', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const external = await ExternalKeyPair.create({
      publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])),
      sign: async (data) => new Uint8Array(nodeSign('sha256', data, privateKey)),
    });
    const cert = certify(await publicKeyLine(external), 'hardware', ['-n', user]);
    const s = session(await CertKeyPair.create(external, cert));
    try {
      await echo(s, 'cert-hardware');
    } finally {
      await s.close();
    }
  });

  it('an expired certificate, or one for another user, is refused and the error says why', async () => {
    const key = await generateKey();
    const line = await publicKeyLine(key);
    // Local dates (older ssh-keygen has no UTC suffix): the end is 2020-01-01 or -02 in UTC.
    const expired = await CertKeyPair.create(key, certify(line, 'expired', ['-n', user, '-V', '20200101:20200102']));
    await assert.rejects(RemoteShell.connect(await connectTcp(host, Number(port)), { username: user, key: expired, verifyHostKey: (k) => hostKeyId(k) === pinned }), /authentication failed.*certificate "expired" expired 2020-01-0[12]T/);
    const other = await CertKeyPair.create(key, certify(line, 'other', ['-n', 'not-this-user']));
    await assert.rejects(RemoteShell.connect(await connectTcp(host, Number(port)), { username: user, key: other, verifyHostKey: (k) => hostKeyId(k) === pinned }), /authentication failed.*not for user/);
    // A refused host key: no certificate hint (nothing was sent).
    await assert.rejects(RemoteShell.connect(await connectTcp(host, Number(port)), { username: user, key: expired, verifyHostKey: () => false }), (e: Error) => /authentication failed/.test(e.message) && !/expired/.test(e.message));
  });

  it('agent certificates (Ed25519, ECDSA P-256/384/521, RSA as rsa-sha2-512) log in', async () => {
    const types = [
      { file: 'agent_ed25519', type: 'ed25519' },
      { file: 'agent_p256', type: 'ecdsa', bits: ['-b', '256'] },
      { file: 'agent_p384', type: 'ecdsa', bits: ['-b', '384'] },
      { file: 'agent_p521', type: 'ecdsa', bits: ['-b', '521'] },
      { file: 'agent_rsa', type: 'rsa' },
    ];
    await withAgent(
      'agent-certs',
      types,
      (file) => execFileSync('ssh-keygen', ['-q', '-s', userCa, '-I', path.basename(file), '-n', user, `${file}.pub`]),
      async (sock) => {
        const { agentAlgorithms, agentKeys } = await import('@md-runbook/ssh/node');
        const keys = await agentKeys(sock);
        const certs = keys.filter((k) => k.keyAlgorithmName.endsWith('-cert-v01@openssh.com'));
        assert.deepEqual(certs.map((k) => k.keyAlgorithmName).sort(), [
          'ecdsa-sha2-nistp256-cert-v01@openssh.com',
          'ecdsa-sha2-nistp384-cert-v01@openssh.com',
          'ecdsa-sha2-nistp521-cert-v01@openssh.com',
          'ssh-ed25519-cert-v01@openssh.com',
          'ssh-rsa-cert-v01@openssh.com',
        ]);
        // Certificates first: they are what logs in here.
        assert.deepEqual(keys.slice(0, certs.length), certs);
        for (const key of certs) {
          const s = session(key, { configure: agentAlgorithms });
          try {
            await echo(s, 'cert-agent');
          } catch (e) {
            throw new Error(`${key.keyAlgorithmName}: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            await s.close();
          }
        }
        // The plain keys alone are refused (not in authorized_keys).
        const plain = keys.find((k) => k.keyAlgorithmName === 'ssh-ed25519')!;
        await assert.rejects(RemoteShell.connect(await connectTcp(host, Number(port)), { username: user, key: plain, configure: agentAlgorithms, verifyHostKey: (k) => hostKeyId(k) === pinned }), /authentication failed/);
      },
    );
  });

  it("a certificate the host doesn't trust costs one try: the 5th plain agent key still logs in", async () => {
    // Another CA, which sshd doesn't trust: as a host outside the company's CA.
    const otherCa = path.join(dir, 'other_ca');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other-ca', '-f', otherCa]);
    const plain = [1, 2, 3, 4, 5].map((n) => ({ file: `plain_${n}`, type: 'ed25519' }));
    await withAgent(
      'agent-plain',
      plain,
      (file) => {
        if (file.endsWith('plain_1')) execFileSync('ssh-keygen', ['-q', '-s', otherCa, '-I', 'untrusted', '-n', user, `${file}.pub`]);
        // Only the last plain key is on the host.
        if (file.endsWith('plain_5')) fs.appendFileSync(process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, fs.readFileSync(`${file}.pub`, 'utf8'));
      },
      async (sock) => {
        const { agentAlgorithms, agentKeys } = await import('@md-runbook/ssh/node');
        const { chooseLoginKeys } = await import('@md-runbook/ssh');
        const keys = await chooseLoginKeys({ agent: await agentKeys(sock) });
        // The certificate, then the 5 plain keys: 6 tries, sshd's default MaxAuthTries.
        assert.equal(keys.length, 6);
        assert.equal(keys[0]!.keyAlgorithmName, 'ssh-ed25519-cert-v01@openssh.com');
        const s = session(keys[0]!, { moreKeys: keys.slice(1), configure: agentAlgorithms });
        try {
          await echo(s, 'plain-5');
        } finally {
          await s.close();
        }
      },
    );
  });
});

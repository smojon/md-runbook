/**
 * The SSH agent client (packages/ssh/src/agent.ts) against a fake agent that holds Ed25519, ECDSA
 * and RSA keys in Node's crypto: the messages, the signature formats, and that the library (or
 * Node, for Ed25519) verifies what the agent signed.
 */
import { strict as assert } from 'node:assert';
import { KeyObject, generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Buffer } from 'buffer';
import { SshAlgorithms, SshSessionConfiguration } from '@microsoft/dev-tunnels-ssh';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { certAlgorithms, sessionConfiguration } from '@md-runbook/ssh';
import { testCertificate } from './sshCertFixture';
import {
  AgentClient,
  AgentKeyPair,
  Ed25519Algorithm,
  Ed25519PublicKey,
  WINDOWS_AGENT_PIPE,
  agentAlgorithms,
  agentKeys,
  agentPath,
  blobType,
  parseIdentities,
  signRequest,
} from '@md-runbook/ssh/node';

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
const str = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
  return Buffer.concat([u32(v.length), v]);
};
/** An SSH mpint of an unsigned big-endian number. */
const mpint = (b: Uint8Array): Buffer => {
  let v = Buffer.from(b);
  while (v.length > 1 && v[0] === 0 && v[1]! < 0x80) v = v.subarray(1);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return str(v);
};
const b64u = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64url');

interface FakeKey {
  blob: Buffer;
  sign(data: Buffer): Buffer;
}

function ed25519(): FakeKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const blob = Buffer.concat([str('ssh-ed25519'), str(b64u(publicKey.export({ format: 'jwk' }).x))]);
  return { blob, sign: (d) => Buffer.concat([str('ssh-ed25519'), str(nodeSign(null, d, privateKey))]) };
}

function ecdsa(): FakeKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]))]);
  return {
    blob,
    sign: (d) => {
      const rs = nodeSign('sha256', d, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return Buffer.concat([str('ecdsa-sha2-nistp256'), str(Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]))]);
    },
  };
}

function rsa(): FakeKey & { privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([str('ssh-rsa'), mpint(b64u(jwk.e)), mpint(b64u(jwk.n))]);
  return { blob, privateKey, sign: (d) => Buffer.concat([str('rsa-sha2-512'), str(nodeSign('sha512', d, privateKey))]) };
}

/** An agent on a socket (a named pipe on Windows); `refuse` answers SSH_AGENT_FAILURE to signing. */
function fakeAgent(keys: FakeKey[], opts: { refuse?: boolean; extra?: Buffer[] } = {}): Promise<{ path: string; close(): void; flags: number[] }> {
  const where =
    process.platform === 'win32' ? `\\\\.\\pipe\\mdrb-agent-test-${randomBytes(6).toString('hex')}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-agent-')), 'sock');
  const flags: number[] = [];
  const server = net.createServer((socket) => {
    let got = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      while (got.length >= 4 && got.length >= 4 + got.readUInt32BE(0)) {
        const n = got.readUInt32BE(0);
        const msg = got.subarray(4, 4 + n);
        got = got.subarray(4 + n);
        const reply = (body: Buffer): void => void socket.write(Buffer.concat([u32(body.length), body]));
        if (msg[0] === 11) {
          const listed = [...keys.map((k) => k.blob), ...(opts.extra ?? [])];
          reply(Buffer.concat([Buffer.from([12]), u32(listed.length), ...listed.map((b) => Buffer.concat([str(b), str('test key')]))]));
        } else if (msg[0] === 13) {
          let at = 1;
          const take = (): Buffer => {
            const len = msg.readUInt32BE(at);
            const v = msg.subarray(at + 4, at + 4 + len);
            at += 4 + len;
            return Buffer.from(v);
          };
          const blob = take();
          const data = take();
          flags.push(msg.readUInt32BE(at));
          const key = keys.find((k) => k.blob.equals(blob));
          if (!key || opts.refuse) reply(Buffer.from([5]));
          else reply(Buffer.concat([Buffer.from([14]), str(key.sign(data))]));
        } else reply(Buffer.from([5]));
      }
    });
  });
  return new Promise((resolve) => server.listen(where, () => resolve({ path: where, close: () => server.close(), flags })));
}

describe('ssh: agent keys', () => {
  const keys = { ed: ed25519(), ec: ecdsa(), rsa: rsa() };
  let agent: Awaited<ReturnType<typeof fakeAgent>>;
  before(async () => {
    // A DSA key the agent lists is left out (the library can't log in with it).
    agent = await fakeAgent([keys.ed, keys.ec, keys.rsa], { extra: [Buffer.concat([str('ssh-dss'), str('x')])] });
  });
  after(() => agent.close());

  it('finds the agent: SSH_AUTH_SOCK, else the Windows pipe on Windows', () => {
    assert.equal(agentPath({ SSH_AUTH_SOCK: '/tmp/a.sock' }, 'linux'), '/tmp/a.sock');
    assert.equal(agentPath({}, 'linux'), undefined);
    assert.equal(agentPath({ SSH_AUTH_SOCK: '  ' }, 'darwin'), undefined);
    assert.equal(agentPath({}, 'win32'), WINDOWS_AGENT_PIPE);
    assert.equal(WINDOWS_AGENT_PIPE, '\\\\.\\pipe\\openssh-ssh-agent');
  });

  it('lists the usable keys, with their types and comments', async () => {
    const ids = await new AgentClient(agent.path).identities();
    assert.deepEqual(
      ids.map((k) => k.type),
      ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'],
    );
    assert.equal(ids[0]!.comment, 'test key');
    assert.ok(ids[0]!.blob.equals(keys.ed.blob));
  });

  it('parses messages and refuses short ones', () => {
    assert.equal(blobType(keys.rsa.blob), 'ssh-rsa');
    assert.throws(() => parseIdentities(Buffer.from([0, 0, 0, 1, 0, 0])), /short/);
    assert.deepEqual(parseIdentities(u32(0)), []);
    // RSA keys sign with SHA-512 (flag 4); others with no flag.
    const r = signRequest(keys.rsa.blob, Buffer.from('d'));
    assert.equal(r[0], 13);
    assert.equal(r.readUInt32BE(r.length - 4), 4);
    const e = signRequest(keys.ed.blob, Buffer.from('d'));
    assert.equal(e.readUInt32BE(e.length - 4), 0);
  });

  it('ECDSA and RSA: the agent signs, the library verifies', async () => {
    const config = new SshSessionConfiguration();
    agentAlgorithms(config);
    const [, ec, rs] = await agentKeys(agent.path);
    const data = Buffer.from('session data');
    for (const [key, name, lib] of [
      [ec!, 'ecdsa-sha2-nistp256', SshAlgorithms.publicKey.ecdsaSha2Nistp256!],
      [rs!, 'rsa-sha2-512', SshAlgorithms.publicKey.rsaWithSha512!],
    ] as const) {
      // What authentication picks: the first algorithm for the key's type.
      const alg = config.publicKeyAlgorithms.find((a) => a?.keyAlgorithmName === key.keyAlgorithmName)!;
      assert.equal(alg.name, name);
      const sig = await alg.createSigner(key).sign(data);
      const pub = lib.createKeyPair();
      await pub.setPublicKeyBytes((await key.getPublicKeyBytes())!);
      assert.equal(await lib.createVerifier(pub).verify(data, sig), true, name);
      assert.equal(await lib.createVerifier(pub).verify(Buffer.from('other'), sig), false, name);
      // The signature goes out as `string name, string signature`, as OpenSSH expects.
      assert.ok(alg.createSignatureData(sig).subarray(4, 4 + name.length).equals(Buffer.from(name)));
    }
  });

  it('Ed25519: the agent signs, Node verifies (host keys of the type too)', async () => {
    const config = new SshSessionConfiguration();
    agentAlgorithms(config);
    agentAlgorithms(config); // twice changes nothing
    const ed = config.publicKeyAlgorithms.filter((a) => a?.name === 'ssh-ed25519');
    assert.equal(ed.length, 1);
    // After the library's own, then P-521: servers are asked for their ECDSA or RSA host key first.
    assert.deepEqual(
      config.publicKeyAlgorithms.map((a) => a?.name),
      ['rsa-sha2-512', 'rsa-sha2-256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'ecdsa-sha2-nistp521'],
    );
    const [key] = await agentKeys(agent.path);
    const data = Buffer.from('exchange hash');
    const sig = await ed[0]!.createSigner(key!).sign(data);
    assert.equal(sig.length, 64);
    const host = ed[0]!.createKeyPair() as Ed25519PublicKey;
    await host.setPublicKeyBytes(keys.ed.blob);
    assert.equal(await ed[0]!.createVerifier(host).verify(data, sig), true);
    assert.equal(await ed[0]!.createVerifier(host).verify(Buffer.from('x'), sig), false);
    await assert.rejects(new Ed25519PublicKey().setPublicKeyBytes(keys.ec.blob), /not an Ed25519/);
  });

  it('a refused signature, or no agent, is an error with a reason', async () => {
    const refusing = await fakeAgent([keys.ed], { refuse: true });
    try {
      const [key] = await agentKeys(refusing.path);
      await assert.rejects(new AgentClient(refusing.path).sign(key!.identity.blob, Buffer.from('d')), /refused to sign/);
    } finally {
      refusing.close();
    }
    const missing = process.platform === 'win32' ? '\\\\.\\pipe\\mdrb-no-such-agent' : path.join(os.tmpdir(), 'mdrb-no-such-agent.sock');
    await assert.rejects(agentKeys(missing), /no SSH agent at/);
    assert.deepEqual(await agentKeys(undefined), []);
    assert.ok((await agentKeys(agent.path))[0] instanceof AgentKeyPair);
  });
});

// `ssh-add id` also loads id-cert.pub: the agent lists the key and its certificate, and signs
// with either blob; OpenSSH names the signature with the plain type (checked with OpenSSH 9.7).
describe('ssh: agent certificates', () => {
  const ed = ed25519();
  const rs = rsa();
  const edCert: FakeKey = { blob: testCertificate(ed.blob), sign: ed.sign };
  const rsCert: FakeKey = { blob: testCertificate(rs.blob), sign: rs.sign };
  let agent: Awaited<ReturnType<typeof fakeAgent>>;
  before(async () => {
    agent = await fakeAgent([ed, edCert, rs, rsCert]);
  });
  after(() => agent.close());

  it('host key types offered, in order: as before, then P-521 after Ed25519, certificates last', () => {
    const names = (configure: ((c: SshSessionConfiguration) => void) | undefined, cert: boolean) =>
      sessionConfiguration({ configure }, cert ? [{ keyAlgorithmName: 'ecdsa-sha2-nistp256-cert-v01@openssh.com' } as KeyPair] : []).publicKeyAlgorithms.map((a) => a?.name);
    const vscode = [
      'ecdsa-sha2-nistp256',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp256',
      'sk-ecdsa-sha2-nistp256@openssh.com',
      'ssh-ed25519',
      'ecdsa-sha2-nistp521',
    ];
    // VS Code (agentAlgorithms): a server with Ed25519 and P-521 host keys still shows its Ed25519 one.
    assert.deepEqual(names(agentAlgorithms, false), vscode);
    assert.deepEqual(names(agentAlgorithms, true), [
      ...vscode,
      'ssh-ed25519-cert-v01@openssh.com',
      'ecdsa-sha2-nistp256-cert-v01@openssh.com',
      'ecdsa-sha2-nistp384-cert-v01@openssh.com',
      'ecdsa-sha2-nistp521-cert-v01@openssh.com',
      'rsa-sha2-512-cert-v01@openssh.com',
    ]);
    // The app (no configure): as before; certificates only last.
    const app = ['ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp256', 'sk-ecdsa-sha2-nistp256@openssh.com'];
    assert.deepEqual(names(undefined, false), app);
    assert.deepEqual(names(undefined, true), [...app, 'ecdsa-sha2-nistp256-cert-v01@openssh.com', 'ecdsa-sha2-nistp384-cert-v01@openssh.com', 'rsa-sha2-512-cert-v01@openssh.com']);
  });

  it('lists certificates, first (sshd counts each key tried)', async () => {
    const ids = await new AgentClient(agent.path).identities();
    assert.deepEqual(
      ids.map((k) => k.type),
      ['ssh-ed25519', 'ssh-ed25519-cert-v01@openssh.com', 'ssh-rsa', 'ssh-rsa-cert-v01@openssh.com'],
    );
    assert.deepEqual(
      (await agentKeys(agent.path)).map((k) => k.keyAlgorithmName),
      ['ssh-ed25519-cert-v01@openssh.com', 'ssh-rsa-cert-v01@openssh.com', 'ssh-ed25519', 'ssh-rsa'],
    );
    // An RSA certificate signs with SHA-512 too (flag 4).
    const r = signRequest(rsCert.blob, Buffer.from('d'));
    assert.equal(r.readUInt32BE(r.length - 4), 4);
  });

  it('the agent signs with the certificate; the plain key verifies; the login names the certificate type', async () => {
    const config = new SshSessionConfiguration();
    agentAlgorithms(config);
    certAlgorithms(config);
    const [edKey, rsKey] = await agentKeys(agent.path);
    const data = Buffer.from('login data');
    const find = (k: AgentKeyPair) => config.publicKeyAlgorithms.find((a) => a?.keyAlgorithmName === k.keyAlgorithmName)!;

    const edAlg = find(edKey!);
    assert.equal(edAlg.name, 'ssh-ed25519-cert-v01@openssh.com');
    const edSig = await edAlg.createSigner(edKey!).sign(data);
    const host = new Ed25519PublicKey();
    await host.setPublicKeyBytes(ed.blob);
    assert.equal(await new Ed25519Algorithm().createVerifier(host).verify(data, edSig), true);
    assert.ok((await edKey!.getPublicKeyBytes())!.equals(edCert.blob));

    const rsAlg = find(rsKey!);
    assert.equal(rsAlg.name, 'rsa-sha2-512-cert-v01@openssh.com');
    agent.flags.length = 0;
    const rsSig = await rsAlg.createSigner(rsKey!).sign(data);
    assert.deepEqual(agent.flags, [4]);
    const lib = SshAlgorithms.publicKey.rsaWithSha512!;
    const pub = lib.createKeyPair();
    await pub.setPublicKeyBytes(rs.blob);
    assert.equal(await lib.createVerifier(pub).verify(data, rsSig), true);
    const wire = rsAlg.createSignatureData(rsSig);
    assert.equal(wire.subarray(4, 4 + wire.readUInt32BE(0)).toString(), 'rsa-sha2-512');
  });

  it('an agent that names the signature otherwise is refused', async () => {
    const odd: FakeKey = {
      blob: testCertificate(ed.blob),
      sign: (d) => {
        const sig = ed.sign(d);
        return Buffer.concat([str('ssh-ed25519-cert-v01@openssh.com'), sig.subarray(4 + 11)]);
      },
    };
    const wrong = await fakeAgent([odd]);
    try {
      const config = new SshSessionConfiguration();
      agentAlgorithms(config);
      certAlgorithms(config);
      const [key] = await agentKeys(wrong.path);
      const alg = config.publicKeyAlgorithms.find((a) => a?.keyAlgorithmName === key!.keyAlgorithmName)!;
      await assert.rejects(alg.createSigner(key!).sign(Buffer.from('d')), /signed with ssh-ed25519-cert-v01@openssh\.com, not ssh-ed25519/);
    } finally {
      wrong.close();
    }
  });
});

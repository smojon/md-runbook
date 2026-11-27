/**
 * The login's keys, against an SSH server in this process (the library's own server side) that
 * knows one key and, as sshd does at MaxAuthTries, ends the connection at its Nth refused key
 * instead of refusing it: a key that can't sign is skipped, and the keys left after such an end
 * are tried over a new connection.
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import * as net from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  KeyPair,
  NodeStream,
  SshAlgorithms,
  SshAuthenticatingEventArgs,
  SshAuthenticationType,
  SshChannel,
  SshDisconnectReason,
  SshExtendedDataType,
  SshServerSession,
  SshSessionConfiguration,
} from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { CertKeyPair, ExternalKeyPair, RemoteSession, RemoteShell, generateKey } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';
import { testCertificateLine } from './sshCertFixture';

const HELLO = /^: mdrb-gate-hello (\w+)[ ;][^\n]*\n/;
const PROBE = /^__mdrb_sh=0;[^\n]*__MDRB_(\w+)__[^\n]*\n/;

/** Answers the shell's hello and probe (bash): enough for connect to resolve. */
function playShell(ch: SshChannel): void {
  let pending = '';
  const marker = async (id: string, value: number): Promise<void> => {
    const line = `\x1e__MDRB_${id}__ ${value}\n`;
    await ch.sendExtendedData(SshExtendedDataType.STDERR, Buffer.from(line, 'utf8'));
    await ch.send(Buffer.from(line, 'utf8'));
  };
  ch.onDataReceived((data) => {
    pending += Buffer.from(data).toString('utf8');
    ch.adjustWindow(data.length);
    void (async () => {
      for (;;) {
        let m: RegExpExecArray | null;
        if ((m = HELLO.exec(pending))) await marker(m[1]!, 4242);
        else if ((m = PROBE.exec(pending))) await marker(m[1]!, 1);
        else return;
        pending = pending.slice(m[0].length);
      }
    })();
  });
}

const blobOf = async (k: KeyPair): Promise<string> => Buffer.from((await k.getPublicKeyBytes())!).toString('base64');

/** A hardware key (P-256, signs outside JavaScript); `fail` makes its signer throw, as a cancelled prompt does. */
async function hardwareKey(fail?: string): Promise<ExternalKeyPair & { signs: number }> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const counter = { signs: 0 };
  const key = await ExternalKeyPair.create({
    publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])),
    sign: async (data) => {
      counter.signs++;
      if (fail) throw new Error(fail);
      return new Uint8Array(nodeSign('sha256', data, privateKey));
    },
  });
  return Object.defineProperty(key, 'signs', { get: () => counter.signs }) as ExternalKeyPair & { signs: number };
}

describe('ssh: the login tries each key once', () => {
  let server: net.Server;
  let port = 0;
  let hostKey: KeyPair;
  /** The key the server accepts (base64 of its blob). */
  let authorized = '';
  /** The connection ends at this many refused keys (sshd's MaxAuthTries). */
  let maxTries = 6;
  /** A refusal lists keyboard-interactive only, as sshd's does once publickey is done or off. */
  let noMorePublicKey = false;
  /** The keys offered, per connection. */
  let offered: string[][] = [];
  const open = () => connectTcp('127.0.0.1', port);
  const base = { username: 'deploy', verifyHostKey: () => true, keepAliveSeconds: 0 };

  before(async () => {
    hostKey = await SshAlgorithms.publicKey.ecdsaSha2Nistp256!.generateKeyPair();
    server = net.createServer((socket) => {
      const tried: string[] = [];
      offered.push(tried);
      const config = new SshSessionConfiguration();
      config.maxClientAuthenticationAttempts = 100;
      const session = new SshServerSession(config);
      session.credentials = { publicKeys: [hostKey] };
      session.onAuthenticating((e: SshAuthenticatingEventArgs) => {
        if (e.authenticationType !== SshAuthenticationType.clientPublicKey || !e.publicKey) return;
        const key = e.publicKey;
        e.authenticationPromise = (async () => {
          const blob = await blobOf(key);
          tried.push(blob);
          if (blob === authorized) return {};
          if (tried.length >= maxTries) await session.close(SshDisconnectReason.noMoreAuthMethodsAvailable, 'Too many authentication failures');
          // The library's refusal lists the configured methods.
          if (noMorePublicKey) config.authenticationMethods.splice(0, config.authenticationMethods.length, ...config.authenticationMethods.filter((m) => m !== 'publickey'));
          return null;
        })();
      });
      session.onChannelOpening((e) => {
        const ch = e.channel;
        ch.onRequest((r) => {
          if (r.requestType !== 'exec') return;
          r.isAuthorized = true;
          playShell(ch);
        });
      });
      socket.on('error', () => undefined);
      void session.connect(new NodeStream(socket)).catch(() => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());
  beforeEach(() => {
    offered = [];
    maxTries = 6;
    noMorePublicKey = false;
  });

  it("a key that can't sign is skipped: the next key logs in on the same connection", async () => {
    const cancelled = await hardwareKey('the hardware key was cancelled');
    const good = await generateKey();
    authorized = await blobOf(good);
    const shell = await RemoteShell.connect(open, { ...base, key: cancelled, moreKeys: [good] });
    try {
      assert.equal(cancelled.signs, 1);
      assert.deepEqual(offered, [[authorized]]);
    } finally {
      await shell.close();
    }
  });

  it('more keys than the server allows: the keys left are tried over a new connection, each once, in order', async () => {
    maxTries = 3;
    const keys = await Promise.all(Array.from({ length: 8 }, () => generateKey()));
    const blobs = await Promise.all(keys.map(blobOf));
    authorized = blobs[7]!;
    let hostKeyChecks = 0;
    const session = new RemoteSession(open, { ...base, key: keys[0]!, moreKeys: keys.slice(1), verifyHostKey: () => (hostKeyChecks++, true) });
    try {
      await session.connect();
      assert.equal(session.isConnected, true);
      assert.deepEqual(offered, [blobs.slice(0, 3), blobs.slice(3, 6), blobs.slice(6)]);
      // The same host key on the next connections: accepted without asking again.
      assert.equal(hostKeyChecks, 1);
    } finally {
      await session.close();
    }
  });

  it('another host key on the next connection is checked again, and a refusal ends the login', async () => {
    maxTries = 1;
    const keys = await Promise.all(Array.from({ length: 3 }, () => generateKey()));
    authorized = await blobOf(keys[2]!);
    let checks = 0;
    // The first check accepts, the next (a key that is not the accepted one) refuses.
    const opts = { ...base, key: keys[0]!, moreKeys: keys.slice(1), verifyHostKey: () => checks++ === 0 };
    const old = hostKey;
    const other = await SshAlgorithms.publicKey.ecdsaSha2Nistp256!.generateKeyPair();
    let first = true;
    const swap = () => {
      if (!first) hostKey = other;
      first = false;
      return open();
    };
    try {
      await assert.rejects(RemoteShell.connect(swap, opts), (e: Error) => /^authentication failed \(host key refused/.test(e.message) && !/closed the connection/.test(e.message));
      assert.equal(checks, 2);
      assert.equal(offered.length, 2);
      assert.deepEqual(offered[1], []);
    } finally {
      hostKey = old;
    }
  });

  it('with one connection only (a stream, not an opener), the error says how many keys were not tried', async () => {
    maxTries = 2;
    const keys = await Promise.all(Array.from({ length: 5 }, () => generateKey()));
    authorized = await blobOf(keys[4]!);
    await assert.rejects(RemoteShell.connect(await open(), { ...base, key: keys[0]!, moreKeys: keys.slice(1) }), /^Error: authentication failed .*; the server closed the connection before 3 more keys were tried$/);
    assert.equal(offered.length, 1);
  });

  it("when no key logs in, the error still says why a key couldn't sign; its certificate's twin is not asked again", async () => {
    const cancelled = await hardwareKey('the hardware key was cancelled');
    const cert = await CertKeyPair.create(cancelled, testCertificateLine((await cancelled.getPublicKeyBytes())!, { keyId: 'ops', principals: ['deploy'] }));
    const stranger = await generateKey();
    authorized = 'none';
    await assert.rejects(
      RemoteShell.connect(open, { ...base, key: cert, moreKeys: [cancelled, stranger] }),
      /^Error: authentication failed \(host key refused, or the key was not accepted\); a key could not sign: the hardware key was cancelled$/,
    );
    assert.equal(cancelled.signs, 1);
    assert.deepEqual(offered, [[await blobOf(stranger)]]);
  });

  it('a server that takes one key per connection: one connection per key, none beyond', async () => {
    const keys = await Promise.all(Array.from({ length: 3 }, () => generateKey()));
    authorized = 'none';
    maxTries = 1;
    let opens = 0;
    await assert.rejects(
      RemoteShell.connect(async () => (opens++, open()), { ...base, key: keys[0]!, moreKeys: keys.slice(1) }),
      /^Error: authentication failed \(host key refused, or the key was not accepted\)$/,
    );
    assert.equal(opens, 3);
    assert.deepEqual(offered.map((o) => o.length), [1, 1, 1]);
  });

  it('a refusal that no longer lists publickey (AuthenticationMethods, partial success): no more keys, no new connection', async () => {
    const keys = await Promise.all(Array.from({ length: 3 }, () => generateKey()));
    authorized = 'none';
    noMorePublicKey = true;
    let opens = 0;
    await assert.rejects(
      RemoteShell.connect(async () => (opens++, open()), { ...base, key: keys[0]!, moreKeys: keys.slice(1) }),
      /^Error: authentication failed \(host key refused, or the key was not accepted\)$/,
    );
    assert.equal(opens, 1);
    assert.deepEqual(offered, [[await blobOf(keys[0]!)]]);
  });

  it('the connect timeout during a reconnect: the error is the timeout, and the late connection is closed', async () => {
    const keys = await Promise.all(Array.from({ length: 2 }, () => generateKey()));
    authorized = await blobOf(keys[1]!);
    maxTries = 1;
    let opens = 0;
    let lateClosed = false;
    let late: Promise<unknown> = Promise.resolve();
    const slowSecond = async () => {
      if (opens++ === 0) return open();
      const p = (async () => {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await open();
        const close = s.close.bind(s);
        s.close = () => ((lateClosed = true), close());
        return s;
      })();
      late = p;
      return p;
    };
    await assert.rejects(RemoteShell.connect(slowSecond, { ...base, key: keys[0]!, moreKeys: keys.slice(1), connectTimeoutMs: 500 }), /^Error: connecting timed out/);
    await late;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lateClosed, true);
    // The second key was never offered (the late connection opened, and closed).
    assert.deepEqual(offered.flat(), [await blobOf(keys[0]!)]);
  });

  it("a reconnect that fails (network, relay) says so, not that authentication failed", async () => {
    const keys = await Promise.all(Array.from({ length: 4 }, () => generateKey()));
    authorized = await blobOf(keys[3]!);
    maxTries = 2;
    let opens = 0;
    const failSecond = async () => {
      if (opens++ === 0) return open();
      throw new Error('the relay refused the connection');
    };
    await assert.rejects(
      RemoteShell.connect(failSecond, { ...base, key: keys[0]!, moreKeys: keys.slice(1) }),
      /^Error: the server ended the login with 2 keys left to try, and connecting again failed: the relay refused the connection$/,
    );
    assert.equal(opens, 2);
  });
});

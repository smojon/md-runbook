/**
 * The alert note (gate protocol 3) as RemoteSession sends it, against an SSH server in this
 * process that plays md-runbook-gate of a given protocol: it answers the hello with its banner,
 * and records each request line. A gate of protocol 2 must never get a `note`.
 */
import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  KeyPair,
  NodeStream,
  SshAlgorithms,
  SshAuthenticatingEventArgs,
  SshChannel,
  SshExtendedDataType,
  SshServerSession,
  SshSessionConfiguration,
} from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { RemoteSession, gateAlertNote, gateNoteCommand, generateKey } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const HELLO = /^: mdrb-gate-hello (\w+);[^\n]*\n/;
const REQUEST = /^(\w+) ([0-9a-f]+)((?: [^\n]*)?)\n/;

interface FakeGate {
  protocol: number;
  /** Refuse `note` requests (126), as a gate refuses a bad one. */
  refuseNotes?: boolean;
  /** Every request line after the hello. */
  lines: string[];
}

function playGate(ch: SshChannel, gate: FakeGate): void {
  let pending = '';
  const out = (s: string): Promise<void> => ch.send(Buffer.from(s, 'utf8'));
  const err = (s: string): Promise<void> => ch.sendExtendedData(SshExtendedDataType.STDERR, Buffer.from(s, 'utf8'));
  const marker = async (id: string, value: number): Promise<void> => {
    const line = `\x1e__MDRB_${id}__ ${value}\n`;
    await err(line);
    await out(line);
  };
  ch.onDataReceived((data) => {
    pending += Buffer.from(data).toString('utf8');
    ch.adjustWindow(data.length);
    void (async () => {
      for (;;) {
        let m: RegExpExecArray | null;
        if ((m = HELLO.exec(pending))) {
          await out(`\x1e__MDRB_GATE__ ${gate.protocol} unsigned=refuse\n`);
          await marker(m[1]!, 4242);
        } else if ((m = REQUEST.exec(pending))) {
          const [, verb, id] = m;
          gate.lines.push(m[0].trimEnd());
          if (verb === 'load') await out(`\x1e__MDRB_SIGNED__ ops@example.net ${'a'.repeat(64)}\n`);
          if (verb === 'run') await out('ran\n');
          if (verb === 'note' && gate.refuseNotes) {
            await err('md-runbook-gate: bad note request\n');
            await marker(id!, 126);
          } else if (verb === 'note' && gate.protocol < 3) {
            await err('md-runbook-gate: unknown request note\n');
            await marker(id!, 126);
          } else await marker(id!, 0);
        } else return;
        pending = pending.slice(m[0].length);
      }
    })();
  });
}

describe('ssh: the alert note to md-runbook-gate', () => {
  let server: net.Server;
  let port = 0;
  let hostKey: KeyPair;
  let key: KeyPair;
  let gate: FakeGate = { protocol: 3, lines: [] };
  const open = () => connectTcp('127.0.0.1', port);
  const opts = () => ({ username: 'support', key, verifyHostKey: () => true, keepAliveSeconds: 0 });
  const signed = { manifest: 'md-runbook-manifest 1\nname ops/x\n', signature: 'U1NIU0lH', cell: 1 };
  const verbs = (): string[] => gate.lines.map((l) => l.split(' ')[0]!);
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

  before(async () => {
    hostKey = await SshAlgorithms.publicKey.ecdsaSha2Nistp256!.generateKeyPair();
    key = await generateKey();
    server = net.createServer((socket) => {
      const session = new SshServerSession(new SshSessionConfiguration());
      session.credentials = { publicKeys: [hostKey] };
      session.onAuthenticating((e: SshAuthenticatingEventArgs) => (e.authenticationPromise = Promise.resolve({})));
      session.onChannelOpening((e) => {
        const ch = e.channel;
        ch.onRequest((r) => {
          if (r.requestType !== 'exec') return;
          r.isAuthorized = true;
          playGate(ch, gate);
        });
      });
      socket.on('error', () => undefined);
      void session.connect(new NodeStream(socket)).catch(() => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());

  it('protocol 3: the note goes before the load, once; another alert loads the runbook again', async () => {
    gate = { protocol: 3, lines: [] };
    const session = new RemoteSession(open, opts());
    try {
      const alert = { name: 'ApiDown', fingerprint: '5f3c9e', startsAt: '2026-11-14T08:58:00Z' };
      assert.equal((await session.run('', {}, { ...signed, alert })).exitCode, 0);
      assert.equal((await session.run('', {}, { ...signed, alert })).exitCode, 0);
      assert.deepEqual(verbs(), ['note', 'load', 'run', 'run']);
      assert.match(gate.lines[0]!, new RegExp(`^note [0-9a-f]+ ALERT ${b64('ApiDown')} ALERT_FINGERPRINT ${b64('5f3c9e')} ALERT_STARTS_AT ${b64('2026-11-14T08:58:00Z')}$`));
      // The alert's values changed on the Parameters card: loaded again, so the log says so.
      assert.equal((await session.run('', {}, { ...signed, alert: { name: 'DiskFull' } })).exitCode, 0);
      // No alert any more: loaded again, without a note.
      assert.equal((await session.run('', {}, signed)).exitCode, 0);
      assert.deepEqual(verbs(), ['note', 'load', 'run', 'run', 'note', 'load', 'run', 'load', 'run']);
      assert.match(gate.lines[4]!, new RegExp(`^note [0-9a-f]+ ALERT ${b64('DiskFull')}$`));
    } finally {
      await session.close();
    }
  });

  it('protocol 2: no note is ever sent, and the runs go on as before', async () => {
    gate = { protocol: 2, lines: [] };
    const session = new RemoteSession(open, opts());
    try {
      assert.equal((await session.run('', {}, { ...signed, alert: { name: 'ApiDown' } })).exitCode, 0);
      assert.equal((await session.run('', {}, { ...signed, alert: { name: 'DiskFull' } })).exitCode, 0);
      assert.deepEqual(verbs(), ['load', 'run', 'run']);
    } finally {
      await session.close();
    }
  });

  it('a refused note is only logged by the gate: the run goes on', async () => {
    gate = { protocol: 3, refuseNotes: true, lines: [] };
    const session = new RemoteSession(open, opts());
    try {
      let out = '';
      const r = await session.run('', { onStdout: (t) => (out += t) }, { ...signed, alert: { name: 'ApiDown' } });
      assert.deepEqual([r.exitCode, out], [0, 'ran\n']);
      assert.deepEqual(verbs(), ['note', 'load', 'run']);
    } finally {
      await session.close();
    }
  });

  it('the note keeps to what the gate takes: one line, at most 400 bytes; a bad fingerprint or time is left out', () => {
    assert.equal(gateAlertNote(undefined), undefined);
    assert.equal(gateAlertNote({ name: ' \n\t' }), undefined);
    assert.deepEqual(gateAlertNote({ name: ' Api\nDown\x07 ', fingerprint: 'has space', startsAt: 'yesterday' }), { name: 'Api Down' });
    assert.deepEqual(gateAlertNote({ name: 'A', fingerprint: 'a.b_c:d-e', startsAt: '2026-11-14 08:58+01:00' }), {
      name: 'A',
      fingerprint: 'a.b_c:d-e',
      startsAt: '2026-11-14 08:58+01:00',
    });
    assert.equal(gateAlertNote({ name: 'A', fingerprint: 'f'.repeat(129) })!.fingerprint, undefined);
    // Cut at a character, never inside one: 'é' is 2 bytes.
    const long = gateAlertNote({ name: 'é'.repeat(300) })!.name;
    assert.equal(long, 'é'.repeat(200));
    assert.equal(gateNoteCommand('ab', { name: 'A' }), `note ab ALERT ${b64('A')}\n`);
  });
});

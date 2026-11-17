/**
 * The session's pod (gate protocol 4): where md-runbook-gate runs the cells in a Kubernetes Job,
 * a request waits for the Job's pod, and that wait never counts against the request's time limit.
 * Against an SSH server in this process that plays such a gate: `starting` before a request that
 * waits, then `ready` (or `failed`) after a delay longer than the limit.
 */
import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  CommandRequestMessage,
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
import { GatePodNotice, POD_STARTING_NOTE, PodNoticeFilter, RemoteSession, gatePodNotice, generateKey } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const HELLO = /^: mdrb-gate-hello (\w+)( pod-notices)?;[^\n]*\n/;
const REQUEST = /^(\w+) ([0-9a-f]+)((?: [^\n]*)?)\n/;
const POD = (state: string): string => `\x1e__MDRB_POD__ ${state}\n`;

interface FakeGate {
  protocol: number;
  /** The cells run in a Kubernetes Job (pod notices to a client whose hello asks for them). */
  job: boolean;
  /** How long the pod takes to be ready, from the first request that waits. */
  podMs: number;
  /** The pod won't come: this reason. */
  fail?: string;
  /** The pod gets ready right after the hello (that said `job`), before any request waits. */
  readyAtHello?: boolean;
  /** With `fail`: the pod fails podMs after the hello, while no request waits (the gate says so at once, then ends). */
  failAtHello?: boolean;
  /** With `failAtHello`: the gate ends the session this long after its `failed` notice, and answers no request meanwhile. */
  endAfterFailMs?: number;
  /** Sessions opened (not stop requests). */
  opened?: number;
  /** Whether the client's hello asked for pod notices. */
  asked?: boolean;
  /** Stop requests (second connections). */
  stops: string[];
  /** The session's channel closed: the gate would delete the Job now. */
  closedAt?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function playGate(ch: SshChannel, gate: FakeGate, running: { id?: string; marker?: (id: string, v: number) => Promise<void> }): void {
  let pending = '';
  let busy = false;
  let settled = false;
  let notices = false;
  let final = false;
  let failed = false;
  const out = (s: string): Promise<void> => ch.send(Buffer.from(s, 'utf8'));
  const err = (s: string): Promise<void> => ch.sendExtendedData(SshExtendedDataType.STDERR, Buffer.from(s, 'utf8'));
  const marker = async (id: string, value: number): Promise<void> => {
    const line = `\x1e__MDRB_${id}__ ${value}\n`;
    await err(line);
    await out(line);
  };
  running.marker = marker;
  gate.opened = (gate.opened ?? 0) + 1;
  ch.onClosed(() => (gate.closedAt ??= Date.now()));
  /** A request whose reply the Job's shell prints: false when the pod didn't come. */
  const waitPod = async (): Promise<boolean> => {
    if (!gate.job) return true;
    if (settled) {
      // Told `job`: `ready` before the shell gets its first request.
      if (notices && !final) await err(POD('ready'));
      final = true;
      return true;
    }
    if (notices) await err(POD('starting'));
    const until = Date.now() + gate.podMs;
    while (Date.now() < until && gate.closedAt === undefined) await sleep(20);
    if (gate.closedAt !== undefined) return false;
    settled = true;
    if (gate.fail) {
      await err(notices ? POD(`failed ${gate.fail}`) : `md-runbook-gate: ${gate.fail}\n`);
      await ch.close();
      return false;
    }
    if (notices) await err(POD('ready'));
    final = true;
    return true;
  };
  ch.onDataReceived((data) => {
    pending += Buffer.from(data).toString('utf8');
    ch.adjustWindow(data.length);
    if (busy) return;
    busy = true;
    void (async () => {
      for (;;) {
        let m: RegExpExecArray | null;
        if ((m = HELLO.exec(pending))) {
          pending = pending.slice(m[0].length);
          gate.asked = m[2] !== undefined;
          notices = gate.asked && gate.protocol >= 4 && gate.job;
          await out(`\x1e__MDRB_GATE__ ${gate.protocol} unsigned=allow\n` + (notices ? POD('job') : ''));
          await marker(m[1]!, 4242);
          if (gate.readyAtHello) settled = true;
          const why = gate.fail;
          if (gate.failAtHello && why !== undefined) {
            void (async () => {
              await sleep(gate.podMs);
              settled = true;
              failed = true;
              await err(notices ? POD(`failed ${why}`) : `md-runbook-gate: ${why}
`);
              if (gate.endAfterFailMs) await sleep(gate.endAfterFailMs);
              await ch.close();
            })();
          }
        } else if ((m = REQUEST.exec(pending))) {
          pending = pending.slice(m[0].length);
          const [, verb, id, rest] = m;
          running.id = id;
          if (failed) continue;
          if (verb === 'raw' && Buffer.from(rest!.trim(), 'base64').toString('utf8').includes('REFUSE')) {
            // Refused by the gate itself, before any shell: its reason, exit 126, no notice.
            await err('md-runbook-gate: this server runs signed runbooks only (this cell is not signed, or changed since signing)\n');
            await marker(id!, 126);
            continue;
          }
          if (!(await waitPod())) break;
          if (verb === 'context') {
            await out('lab-1\n');
            await marker(id!, 0);
          } else if (verb === 'raw') {
            const text = Buffer.from(rest!.trim(), 'base64').toString('utf8');
            // A block that prints a pod notice of its own, then runs on (until stopped).
            if (text.includes('FAKE')) await err(POD('starting'));
            if (text.includes('SLEEP') || text.includes('FAKE')) continue;
            await out('ran\n');
            await marker(id!, 0);
          } else await marker(id!, 0);
        } else break;
      }
      busy = false;
    })();
  });
}

describe("ssh: a gate's Kubernetes pod starting", () => {
  let server: net.Server;
  let port = 0;
  let hostKey: KeyPair;
  let key: KeyPair;
  let gate: FakeGate = { protocol: 4, job: true, podMs: 0, stops: [] };
  const open = () => connectTcp('127.0.0.1', port);
  const opts = () => ({ username: 'support', key, verifyHostKey: () => true, keepAliveSeconds: 0 });

  before(async () => {
    hostKey = await SshAlgorithms.publicKey.ecdsaSha2Nistp256!.generateKeyPair();
    key = await generateKey();
    server = net.createServer((socket) => {
      const session = new SshServerSession(new SshSessionConfiguration());
      session.credentials = { publicKeys: [hostKey] };
      session.onAuthenticating((e: SshAuthenticatingEventArgs) => (e.authenticationPromise = Promise.resolve({})));
      const running: { id?: string; marker?: (id: string, v: number) => Promise<void> } = {};
      session.onChannelOpening((e) => {
        const ch = e.channel;
        ch.onRequest((r) => {
          if (r.requestType !== 'exec') return;
          r.isAuthorized = true;
          const command = r.request.convertTo(new CommandRequestMessage()).command ?? '';
          if (command.startsWith('pkill ')) {
            // A stop request: the running block ends as a signal ends it.
            gate.stops.push(command);
            if (running.id && running.marker) void running.marker(running.id, 143);
            void sleep(10).then(() => ch.close());
            return;
          }
          playGate(ch, gate, running);
        });
      });
      socket.on('error', () => undefined);
      void session.connect(new NodeStream(socket)).catch(() => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());

  it('the kube-context probe waits for the pod past its time limit, and says so once', async () => {
    gate = { protocol: 4, job: true, podMs: 1500, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      let out = '';
      let errText = '';
      const notes: string[] = [];
      const r = await session.kubeContext({ timeoutMs: 500, onStdout: (t) => (out += t), onStderr: (t) => (errText += t), onNotice: (t) => notes.push(t) });
      assert.equal(gate.asked, true, 'the hello asks for pod notices');
      assert.deepEqual([r.exitCode, r.timedOut, out, errText], [0, false, 'lab-1\n', '']);
      assert.ok(r.durationMs >= 1400, `${r.durationMs} ms`);
      assert.deepEqual(notes, [POD_STARTING_NOTE]);
      assert.deepEqual(gate.stops, []);
      // The pod is up: the next request runs at once, with no notice.
      const again = await session.kubeContext({ timeoutMs: 500, onNotice: (t) => notes.push(t) });
      assert.equal(again.exitCode, 0);
      assert.deepEqual(notes, [POD_STARTING_NOTE]);
    } finally {
      await session.close();
    }
  });

  it('without onNotice, the line goes to stderr', async () => {
    gate = { protocol: 4, job: true, podMs: 300, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      let errText = '';
      const r = await session.kubeContext({ timeoutMs: 200, onStderr: (t) => (errText += t) });
      assert.equal(r.exitCode, 0);
      assert.equal(errText, `${POD_STARTING_NOTE}\n`);
    } finally {
      await session.close();
    }
  });

  it("the time limit counts again once the pod is ready: a block's timeout= still stops it", async () => {
    gate = { protocol: 4, job: true, podMs: 1200, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      const t0 = Date.now();
      const r = await session.run('SLEEP', { timeoutMs: 600, stopGraceMs: 100 });
      const took = Date.now() - t0;
      assert.equal(r.timedOut, true);
      // The pod's 1.2 s, then the block's own 0.6 s: never stopped during the wait.
      assert.ok(took >= 1700, `${took} ms`);
      assert.match(gate.stops[0] ?? '', /^pkill -TERM -P 4242 /);
    } finally {
      await session.close();
    }
  });

  it('a stop while the pod starts closes the session at once (the gate deletes the Job)', async () => {
    gate = { protocol: 4, job: true, podMs: 10_000, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      await session.connect();
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 700);
      const r = await session.kubeContext({ timeoutMs: 300, signal: ac.signal, onNotice: () => undefined });
      assert.deepEqual([r.cancelled, r.timedOut, r.shellEnded, r.exitCode], [true, false, true, null]);
      assert.equal(r.error, undefined);
      // No signal to a shell that isn't there: the session ended within the stop's first moment.
      assert.deepEqual(gate.stops, []);
      for (let i = 0; i < 50 && gate.closedAt === undefined; i++) await sleep(20);
      assert.ok(gate.closedAt !== undefined && gate.closedAt - t0 < 1500, `closed after ${(gate.closedAt ?? NaN) - t0} ms`);
    } finally {
      await session.close();
    }
  });

  it("a pod that won't come: the gate's reason is the error", async () => {
    const why = "this session's cells can't start: the session's pod wasn't ready after 180 s: see kubectl -n md-runbook-ops describe job md-runbook-cells-ab12c";
    gate = { protocol: 4, job: true, podMs: 600, fail: why, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      const r = await session.kubeContext({ timeoutMs: 200, onNotice: () => undefined });
      assert.deepEqual([r.exitCode, r.timedOut, r.cancelled, r.shellEnded, r.error], [null, false, false, true, why]);
    } finally {
      await session.close();
    }
  });

  it('a gate before protocol 4 sends no notice: the time limit runs as before', async () => {
    gate = { protocol: 3, job: true, podMs: 1500, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      const r = await session.kubeContext({ timeoutMs: 400, stopGraceMs: 100 });
      assert.equal(r.timedOut, true);
      assert.match(gate.stops[0] ?? '', /^pkill -TERM /);
    } finally {
      await session.close();
    }
  });

  it("a block's own pod notice is output, and pauses nothing", async () => {
    // Outside a Job: no notice is ever read.
    gate = { protocol: 4, job: false, podMs: 0, stops: [] };
    let session = new RemoteSession(open, opts());
    try {
      let errText = '';
      const r = await session.run('FAKE', { timeoutMs: 400, stopGraceMs: 100, onStderr: (t) => (errText += t) });
      assert.equal(r.timedOut, true);
      assert.equal(errText, POD('starting'));
    } finally {
      await session.close();
    }
    // In a Job, once the pod is ready: the same.
    gate = { protocol: 4, job: true, podMs: 100, stops: [] };
    session = new RemoteSession(open, opts());
    try {
      assert.equal((await session.kubeContext({ onNotice: () => undefined })).exitCode, 0);
      let errText = '';
      const r = await session.run('FAKE', { timeoutMs: 400, stopGraceMs: 100, onStderr: (t) => (errText += t) });
      assert.equal(r.timedOut, true);
      assert.equal(errText, POD('starting'));
    } finally {
      await session.close();
    }
  });

  it("told `job`, the pod ready before any request waits: `ready` first, then a block's notice is output; its timeout and Stop work", async () => {
    gate = { protocol: 4, job: true, podMs: 0, readyAtHello: true, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      let errText = '';
      const notes: string[] = [];
      const r = await session.run('FAKE', { timeoutMs: 400, stopGraceMs: 100, onStderr: (t) => (errText += t), onNotice: (t) => notes.push(t) });
      assert.deepEqual([r.timedOut, r.shellEnded, errText, notes], [true, undefined, POD('starting'), []]);
      assert.match(gate.stops[0] ?? '', /^pkill -TERM -P 4242 /);
      // Stop, too.
      errText = '';
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const s = await session.run('FAKE', { stopGraceMs: 100, signal: ac.signal, onStderr: (t) => (errText += t), onNotice: (t) => notes.push(t) });
      assert.deepEqual([s.cancelled, s.shellEnded, errText, notes], [true, undefined, POD('starting'), []]);
      assert.match(gate.stops[1] ?? '', /^pkill -TERM -P 4242 /);
    } finally {
      await session.close();
    }
  });

  it("a refused request before the pod's `ready`: the next request still waits, with its notice and pause (round 2, M-1)", async () => {
    gate = { protocol: 4, job: true, podMs: 1200, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      let errText = '';
      const refused = await session.run('REFUSE', { timeoutMs: 500, onStderr: (t) => (errText += t), onNotice: () => undefined });
      assert.equal(refused.exitCode, 126);
      assert.match(errText, /^md-runbook-gate: this server runs signed runbooks only/);
      // The pod's start doesn't count against the time limit, and the notice is no output.
      let out = '';
      errText = '';
      const notes: string[] = [];
      const r = await session.kubeContext({ timeoutMs: 500, stopGraceMs: 100, onStdout: (t) => (out += t), onStderr: (t) => (errText += t), onNotice: (t) => notes.push(t) });
      assert.deepEqual([r.exitCode, r.timedOut, out, errText, notes], [0, false, 'lab-1\n', '', [POD_STARTING_NOTE]]);
      assert.ok(r.durationMs >= 1100, `${r.durationMs} ms`);
      assert.deepEqual(gate.stops, []);
      // After `ready`, a block's notice is its output again.
      errText = '';
      const f = await session.run('FAKE', { timeoutMs: 400, stopGraceMs: 100, onStderr: (t) => (errText += t), onNotice: (t) => notes.push(t) });
      assert.deepEqual([f.timedOut, errText, notes], [true, POD('starting'), [POD_STARTING_NOTE]]);
      assert.match(gate.stops[0] ?? '', /^pkill -TERM -P 4242 /);
    } finally {
      await session.close();
    }
  });

  it("a refused request before the pod's `failed`: the next request gets the gate's reason, and a stop while it waits is quick", async () => {
    const why = "this session's cells can't start: its pod can't start (ImagePullBackOff: x)";
    gate = { protocol: 4, job: true, podMs: 400, fail: why, stops: [] };
    let session = new RemoteSession(open, opts());
    try {
      assert.equal((await session.run('REFUSE', { onNotice: () => undefined })).exitCode, 126);
      const r = await session.kubeContext({ timeoutMs: 200, onNotice: () => undefined });
      assert.deepEqual([r.exitCode, r.timedOut, r.shellEnded, r.error], [null, false, true, why]);
    } finally {
      await session.close();
    }
    // Stop: the session closes at once, no signal sent (nothing runs yet).
    gate = { protocol: 4, job: true, podMs: 10_000, stops: [] };
    session = new RemoteSession(open, opts());
    try {
      assert.equal((await session.run('REFUSE', { onNotice: () => undefined })).exitCode, 126);
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 500);
      const r = await session.kubeContext({ signal: ac.signal, onNotice: () => undefined });
      assert.deepEqual([r.cancelled, r.shellEnded, gate.stops], [true, true, []]);
      assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    } finally {
      await session.close();
    }
  });

  it("the pod fails while no request waits: the next request gets the gate's reason, the one after connects again (L1)", async () => {
    const why = "this session's cells can't start: its pod can't start (ImagePullBackOff: x)";
    gate = { protocol: 4, job: true, podMs: 300, fail: why, failAtHello: true, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      await session.connect();
      for (let i = 0; i < 100 && session.isConnected; i++) await sleep(20);
      assert.equal(session.isConnected, false, 'the gate ended the session');
      let errText = '';
      const r = await session.kubeContext({ timeoutMs: 200, onStderr: (t) => (errText += t), onNotice: () => undefined });
      assert.deepEqual([r.exitCode, r.shellEnded, r.error, errText], [null, true, why, '']);
      assert.equal(gate.opened, 1, 'no new connection for that request');
      // The pod comes this time: a new connection, and the request runs.
      gate.failAtHello = false;
      gate.fail = undefined;
      gate.podMs = 0;
      gate.closedAt = undefined;
      const again = await session.kubeContext({ timeoutMs: 2000, podWaitMaxMs: 5000, onNotice: () => undefined });
      assert.deepEqual([again.exitCode, again.newShell, again.error], [0, true, undefined]);
      assert.equal(gate.opened, 2);
    } finally {
      await session.close();
    }
  });

  it("the pod fails while no request waits, and the shell ends during the next request: that request gets the reason, the one after connects again (re-check L1)", async () => {
    const why = "this session's cells can't start: its pod can't start (ImagePullBackOff: y)";
    gate = { protocol: 4, job: true, podMs: 200, fail: why, failAtHello: true, endAfterFailMs: 1200, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      await session.connect();
      // The notice is in; the gate hasn't ended the session yet.
      await sleep(600);
      assert.equal(session.isConnected, true);
      const r = await session.kubeContext({ timeoutMs: 5000, onNotice: () => undefined });
      assert.deepEqual([r.exitCode, r.shellEnded, r.error], [null, true, why]);
      assert.equal(gate.opened, 1);
      // Shown once: the next request connects again instead of giving the reason a second time.
      gate.failAtHello = false;
      gate.fail = undefined;
      gate.podMs = 0;
      gate.closedAt = undefined;
      const again = await session.kubeContext({ timeoutMs: 2000, podWaitMaxMs: 5000, onNotice: () => undefined });
      assert.deepEqual([again.exitCode, again.newShell, again.error], [0, true, undefined]);
      assert.equal(gate.opened, 2);
    } finally {
      await session.close();
    }
  });

  it('a pod that never gets ready: the wait ends after podWaitMaxMs, as a timeout', async () => {
    gate = { protocol: 4, job: true, podMs: 60_000, stops: [] };
    const session = new RemoteSession(open, opts());
    try {
      const t0 = Date.now();
      const r = await session.kubeContext({ timeoutMs: 200, podWaitMaxMs: 900, onNotice: () => undefined });
      const took = Date.now() - t0;
      assert.deepEqual([r.timedOut, r.cancelled, r.shellEnded, r.exitCode, r.error], [true, false, true, null, "the session's pod didn't start within 1 s"]);
      assert.ok(took >= 850 && took < 5000, `${took} ms`);
      assert.deepEqual(gate.stops, []);
      for (let i = 0; i < 50 && gate.closedAt === undefined; i++) await sleep(20);
      assert.ok(gate.closedAt !== undefined, 'the session closed (the gate deletes the Job)');
    } finally {
      await session.close();
    }
  });

  it('the filter takes notices split across packets, and passes everything else', () => {
    const notices: GatePodNotice[] = [];
    let text = '';
    const f = new PodNoticeFilter(
      (t) => (text += t),
      (n) => notices.push(n),
    );
    for (const piece of ['a\x1e__MDRB_PO', 'D__ star', 'ting\nb\x1e__MDRB_POD__ other\nc\x1e', '__MDRB_x__ 0\n\x1e__MDRB_POD__ ready\n\x1e__MDRB_POD__ starting\n']) f.write(piece);
    f.flush();
    assert.deepEqual(notices, [{ state: 'starting' }, { state: 'ready' }]);
    assert.equal(text, `ab\x1e__MDRB_POD__ other\nc\x1e__MDRB_x__ 0\n\x1e__MDRB_POD__ starting\n`);
    // One byte at a time, too.
    const n2: GatePodNotice[] = [];
    let t2 = '';
    const g = new PodNoticeFilter(
      (t) => (t2 += t),
      (n) => n2.push(n),
    );
    for (const ch of 'x\x1e__MDRB_POD__ starting\ny\x1e__MDRB_POD__ failed why: here\nz') g.write(ch);
    g.flush();
    assert.deepEqual(n2, [{ state: 'starting' }, { state: 'failed', reason: 'why: here' }]);
    assert.equal(t2, 'xyz');
    // stop(), as from the text before a notice in the same packet: that notice is text.
    const n3: GatePodNotice[] = [];
    let t3 = '';
    const h: PodNoticeFilter = new PodNoticeFilter(
      (t) => {
        t3 += t;
        h.stop();
      },
      (n) => n3.push(n),
    );
    h.write('\x1e__MDRB_POD__ starting\nx\x1e__MDRB_POD__ starting\n');
    h.flush();
    assert.deepEqual(n3, [{ state: 'starting' }]);
    assert.equal(t3, 'x\x1e__MDRB_POD__ starting\n');
    assert.deepEqual(gatePodNotice('\x1e__MDRB_POD__ job\n'), { state: 'job' });
    assert.equal(gatePodNotice('\x1e__MDRB_POD__ failed \n'), undefined);
    assert.equal(gatePodNotice('\x1e__MDRB_POD__ ready'), undefined);
  });
});

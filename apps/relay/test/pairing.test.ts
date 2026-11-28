import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { AddressInfo, Server, connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { ConnectorEntry, RelayConfig, loadConfig } from '../src/config';
import { CONNECTOR_SUBPROTOCOL, LogEvent, MAX_CONTROL_FRAME, Relay, SUBPROTOCOL, createRelay, tokenName } from '../src/relay';
import { HIGH_WATER } from '../src/splice';

const V1 = 'a-v1-token-of-at-least-24-chars';
const CLIENT = 'a-client-token-of-at-least-24-chars';
const CONN = 'mdrbc-a-connector-token-for-prod';
const CONN_B = 'mdrbc-a-second-token-for-prod-too';
const CONN_EDGE = 'mdrbc-a-connector-token-for-edge';
const SECRETS = [V1, CLIENT, CONN, CONN_B, CONN_EDGE];

type Msg = Record<string, unknown>;
const portOf = (s: { address(): unknown }): number => (s.address() as AddressInfo).port;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!what()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/**
 * A fake sshd: says hello first, as sshd does, then echoes bytes unchanged. A reset from the
 * relay or the fake connector (a session cut while it still writes) is not an error of the test.
 */
function sshd(): Promise<Server> {
  const s = createServer((sock) => {
    sock.on('error', () => undefined);
    sock.write('SSH-2.0-fake\r\n');
    sock.pipe(sock);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

/** Every log line of this file: none may hold a token, a whole session id or data. */
const allLogs: LogEvent[] = [];
const allIds: string[] = [];

async function startRelay(over: Partial<RelayConfig> = {}, logs: LogEvent[] = []): Promise<{ relay: Relay; url: string; port: number }> {
  const connectors: ConnectorEntry[] = [
    { name: 'prod', token: CONN, sources: [] },
    { name: 'prod', token: CONN_B, sources: [] },
    { name: 'edge', token: CONN_EDGE, sources: [] },
  ];
  const config: RelayConfig = {
    host: '127.0.0.1',
    port: 0,
    tokens: [V1],
    targets: [],
    origins: [],
    maxConnections: 20,
    maxPerClient: 20,
    maxFailures: 100,
    failWindowMs: 60_000,
    trustProxy: true,
    connectTimeoutMs: 2000,
    pingIntervalMs: 30_000,
    maxSessionMs: 60_000,
    connectors,
    clients: [{ token: CLIENT, names: ['prod'] }],
    relayId: 'r-test',
    ...over,
  };
  const relay = createRelay(config, '9.9.9', (e) => {
    logs.push(e);
    allLogs.push(e);
  });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  const port = portOf(relay.server);
  return { relay, url: `ws://127.0.0.1:${port}`, port };
}

/** The headers of the last refusal `dial` saw. */
let refusedHeaders: IncomingHttpHeaders = {};

/** Opens a WebSocket; resolves with it, or with the HTTP status of the refusal. */
function dial(
  url: string,
  path: string,
  protocols: string[],
  opts: { origin?: string; from?: string; autoPong?: boolean } = {},
  setup: (ws: WebSocket) => void = () => undefined,
): Promise<WebSocket | number> {
  const ws = new WebSocket(`${url}${path}`, protocols, {
    origin: opts.origin,
    autoPong: opts.autoPong ?? true,
    // With trustProxy: the address the relay sees.
    ...(opts.from ? { headers: { 'x-forwarded-for': opts.from } } : {}),
  });
  ws.binaryType = 'nodebuffer';
  setup(ws);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => {
      refusedHeaders = res.headers;
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', reject);
  });
}

const client = (url: string, name: string, opts: { token?: string; origin?: string; from?: string; autoPong?: boolean } = {}): Promise<WebSocket | number> =>
  dial(url, `/v1/connect?name=${encodeURIComponent(name)}`, [SUBPROTOCOL, `token.${opts.token ?? CLIENT}`], opts);

interface Fake {
  ws: WebSocket;
  hello: Promise<Msg>;
  /** The next session the relay sends (manual mode). */
  session(): Promise<Msg>;
  /** Sessions received and not yet taken (manual mode). */
  queued(): number;
  /** Statuses of data sockets the relay refused (accept mode). */
  refused: number[];
  data: WebSocket[];
  closed: Promise<number>;
}

/**
 * A fake connector written with ws. `accept`: dial sshd first, then the data socket, and copy;
 * `refuse`: answer each session with a refusal; `manual`: the test does it.
 */
async function connector(
  url: string,
  name: string,
  token: string,
  opts: { mode?: 'accept' | 'refuse' | 'manual'; sshd?: number; from?: string; origin?: string; autoPong?: boolean; dataAutoPong?: boolean } = {},
): Promise<Fake | number> {
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  let gotHello: (m: Msg) => void = () => undefined;
  const hello = new Promise<Msg>((r) => (gotHello = r));
  const refused: number[] = [];
  const data: WebSocket[] = [];
  let closed: Promise<number> = Promise.resolve(0);
  const onSession = (m: Msg): void => {
    allIds.push(String(m.id));
    if (opts.mode === 'refuse') return void fake.ws.send(JSON.stringify({ t: 'refuse', id: m.id, why: 'busy' }));
    if (opts.mode === 'accept') {
      const tcp = connectTcp(opts.sshd!, '127.0.0.1');
      tcp.on('error', () => undefined);
      tcp.on('connect', () => {
        void dial(url, `/v1/connector/accept?id=${String(m.id)}`, [CONNECTOR_SUBPROTOCOL, `token.${token}`], { from: opts.from, autoPong: opts.dataAutoPong }, (d) => {
          d.on('message', (b: Buffer) => tcp.write(b));
          d.on('error', () => undefined);
        }).then((d) => {
          if (typeof d === 'number') {
            refused.push(d);
            return tcp.destroy();
          }
          data.push(d);
          tcp.on('data', (b) => d.send(b));
          tcp.on('close', () => d.close());
          d.on('close', () => tcp.destroy());
        });
      });
      return;
    }
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  };
  const ws = await dial(url, `/v1/connector?name=${name}`, [CONNECTOR_SUBPROTOCOL, `token.${token}`], opts, (w) => {
    closed = new Promise((r) => w.once('close', (code) => r(code)));
    w.on('error', () => undefined);
    w.on('message', (d: Buffer) => {
      const m = JSON.parse(d.toString()) as Msg;
      if (m.t === 'hello') gotHello(m);
      else if (m.t === 'session') onSession(m);
    });
  });
  if (typeof ws === 'number') return ws;
  const fake: Fake = {
    ws,
    hello,
    session: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))),
    queued: () => queue.length,
    refused,
    data,
    closed,
  };
  return fake;
}

const acceptData = (url: string, id: unknown, token: string, opts: { from?: string; autoPong?: boolean } = {}): Promise<WebSocket | number> =>
  dial(url, `/v1/connector/accept?id=${encodeURIComponent(String(id))}`, [CONNECTOR_SUBPROTOCOL, `token.${token}`], opts, (d) => d.on('error', () => undefined));

/** A client upgrade held by the relay: its status (or socket) arrives once the connector answers. */
const held = (url: string, name: string, opts: { token?: string; from?: string } = {}): Promise<WebSocket | number> => client(url, name, opts);

const nextMessage = (ws: WebSocket): Promise<Buffer> => new Promise((r) => ws.once('message', (d: Buffer) => r(d)));
const closed = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once('close', (code) => r(code)));
/** Bytes until `n` have arrived. */
function collect(ws: WebSocket, n: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let got = 0;
  return new Promise((r) =>
    ws.on('message', (d: Buffer) => {
      parts.push(d);
      got += d.length;
      if (got >= n) r(Buffer.concat(parts));
    }),
  );
}
const isWs = (x: unknown): x is WebSocket => x instanceof WebSocket;
function asFake(x: Fake | number): Fake {
  assert.ok(typeof x !== 'number', `connector refused: ${String(x)}`);
  return x;
}

describe('relay pairing', () => {
  let fake: Server;
  let sshdPort: number;
  before(async () => {
    fake = await sshd();
    sshdPort = portOf(fake);
  });
  after(() => {
    fake.close();
    // Never a token, a whole session id, or data in any log line of these tests.
    const text = JSON.stringify(allLogs);
    for (const s of SECRETS) assert.ok(!text.includes(s), 'a token in the log');
    for (const id of allIds) assert.ok(!text.includes(id), 'a whole session id in the log');
    assert.ok(!text.includes('SSH-2.0-fake') && !text.includes('hello from the client'), 'data in the log');
  });

  it('says pair.v1, keeps protocol 1, and pairs a client with its connector both ways', async () => {
    const logs: LogEvent[] = [];
    const { relay, url, port } = await startRelay({}, logs);
    try {
      const info = (await (await fetch(`http://127.0.0.1:${port}/v1/server-info`)).json()) as Msg;
      assert.deepEqual(info, { name: 'md-runbook-relay', protocol: 1, version: '9.9.9', capabilities: ['ssh', 'pair.v1'] });

      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'accept', sshd: sshdPort, from: '192.0.2.10' }));
      assert.deepEqual(await conn.hello, { t: 'hello', relay: 'r-test', ping: 30 });
      assert.equal(conn.ws.protocol, CONNECTOR_SUBPROTOCOL);

      // sshd speaks first: the connector-to-client direction works before the client sends.
      const ws = client(url, 'prod', { from: '203.0.113.5' });
      const c = await ws;
      assert.ok(isWs(c));
      assert.equal(c.protocol, SUBPROTOCOL);
      assert.equal((await nextMessage(c)).toString(), 'SSH-2.0-fake\r\n');
      // Then a lot both ways, intact.
      const big = Buffer.alloc(3 << 20);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
      const back = collect(c, big.length);
      for (let at = 0; at < big.length; at += 200 << 10) c.send(big.subarray(at, at + (200 << 10)));
      assert.ok((await back).equals(big));
      c.send(Buffer.from('hello from the client'));
      assert.equal((await nextMessage(c)).toString(), 'hello from the client');
      assert.equal(relay.open(), 1);
      const done = closed(c);
      c.close(1000);
      assert.equal(await done, 1000);
      await until(() => relay.open() === 0);

      const up = logs.find((l) => l.event === 'connector-up')!;
      assert.deepEqual({ ...up, connectors: 1 }, { event: 'connector-up', name: 'prod', token: tokenName(CONN), connector: '192.0.2.10', connectors: 1 });
      const open = logs.find((l) => l.event === 'open')!;
      const close = logs.find((l) => l.event === 'close')!;
      for (const e of [open, close]) {
        assert.equal(e.mode, 'pair');
        assert.equal(e.client, '203.0.113.5');
        assert.equal(e.token, tokenName(CLIENT));
        assert.equal(e.name, 'prod');
        assert.equal(e.connector, '192.0.2.10');
        assert.match(String(e.session), /^[A-Za-z0-9_-]{8}$/);
      }
      assert.equal(close.why, 'client closed');
      assert.equal(close.up, big.length + 21);
      assert.equal(close.down, big.length + 21 + 14);
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('sends the client address to the connector, with a 128-bit single-use id', async () => {
    const { relay, url } = await startRelay();
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const pendingClient = held(url, 'prod', { from: '198.51.100.23' });
      const s = await conn.session();
      assert.equal(s.client, '198.51.100.23');
      assert.match(String(s.id), /^[A-Za-z0-9_-]{22}$/);
      assert.equal(Buffer.from(String(s.id), 'base64url').length, 16);
      // Another token of the same name, a connector of another name, a made-up id: 404, and the
      // id stays usable.
      assert.equal(await acceptData(url, s.id, CONN_B), 404);
      assert.equal(await acceptData(url, s.id, CONN_EDGE), 404);
      assert.equal(await acceptData(url, 'AAAAAAAAAAAAAAAAAAAAAA', CONN), 404);
      const d = await acceptData(url, s.id, CONN);
      assert.ok(isWs(d));
      const c = await pendingClient;
      assert.ok(isWs(c));
      // Used once: never again.
      assert.equal(await acceptData(url, s.id, CONN), 404);
      const got = nextMessage(d);
      c.send(Buffer.from('x'));
      assert.equal((await got).toString(), 'x');
      c.close();
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('keeps token kinds apart: each in the wrong place gets 401 and counts as a failure', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ maxFailures: 100, targets: ['127.0.0.1:1'] }, logs);
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const ctl = (token: string): Promise<WebSocket | number> => dial(url, '/v1/connector?name=prod', [CONNECTOR_SUBPROTOCOL, `token.${token}`]);
      const ssh = (token: string): Promise<WebSocket | number> => dial(url, '/v1/ssh?target=127.0.0.1:1', [SUBPROTOCOL, `token.${token}`]);
      assert.equal(await ctl(CLIENT), 401, 'client token on the control socket');
      assert.equal(await ctl(V1), 401, 'v1 token on the control socket');
      assert.equal(await acceptData(url, 'x', CLIENT), 401, 'client token on the data socket');
      assert.equal(await client(url, 'prod', { token: CONN }), 401, 'connector token on /v1/connect');
      assert.equal(await ssh(CONN), 401, 'connector token on /v1/ssh');
      assert.equal(await ssh(CLIENT), 401, 'client token on /v1/ssh');
      assert.equal(relay.failureClients(), 1);
      const kinds = logs.filter((l) => l.event === 'refused' && l.status === 401).map((l) => l.why);
      assert.deepEqual(kinds, ['client token', 'v1 token', 'client token', 'connector token', 'connector token', 'client token']);
      // A v1 token is a client token for every name (D5).
      const viaV1 = held(url, 'prod', { token: V1 });
      const s = await conn.session();
      assert.ok(isWs(await acceptData(url, s.id, CONN)));
      const c = await viaV1;
      assert.ok(isWs(c));
      c.close();
      conn.ws.close();
    } finally {
      await relay.close();
    }
    // Counted with the other failures: the lockout follows.
    const locked = await startRelay({ maxFailures: 2 });
    try {
      assert.equal(await client(locked.url, 'prod', { token: CONN, from: '198.51.100.1' }), 401);
      assert.equal(await acceptData(locked.url, 'x', CLIENT, { from: '198.51.100.1' }), 401);
      assert.equal(await client(locked.url, 'prod', { from: '198.51.100.1' }), 429, 'even with the right token');
      assert.equal(await connector(locked.url, 'prod', CONN, { from: '198.51.100.1' }), 429, 'on every endpoint');
    } finally {
      await locked.relay.close();
    }
  });

  it('a client token reaches its names only, and a name must be a name', async () => {
    const { relay, url } = await startRelay();
    try {
      asFake(await connector(url, 'edge', CONN_EDGE, { mode: 'manual' }));
      assert.equal(await client(url, 'edge'), 403);
      assert.equal(await client(url, 'Bad_Name', { token: V1 }), 400);
      assert.equal(await client(url, '-x', { token: V1 }), 400);
    } finally {
      await relay.close();
    }
  });

  it('a connector token registers its own name only, and only from its ranges', async () => {
    const connectors: ConnectorEntry[] = [
      { name: 'prod', token: CONN, sources: [] },
      { name: 'edge', token: CONN_EDGE, sources: [{ address: '198.51.100.0', prefix: 24, family: 'ipv4' }] },
    ];
    const { relay, url } = await startRelay({ connectors });
    try {
      assert.equal(await connector(url, 'edge', CONN), 403, "another name's");
      assert.equal(await connector(url, 'edge', CONN_EDGE, { from: '203.0.113.5' }), 403, 'outside its range');
      const inside = asFake(await connector(url, 'edge', CONN_EDGE, { from: '198.51.100.7', mode: 'manual' }));
      const mapped = asFake(await connector(url, 'edge', CONN_EDGE, { from: '::ffff:198.51.100.8', mode: 'manual' }));
      assert.equal(relay.connectors(), 2);
      // The data socket too.
      const pendingClient = held(url, 'edge', { token: V1 });
      const s = await inside.session();
      assert.equal(await acceptData(url, s.id, CONN_EDGE, { from: '203.0.113.5' }), 403);
      assert.ok(isWs(await acceptData(url, s.id, CONN_EDGE, { from: '198.51.100.9' })));
      assert.ok(isWs(await pendingClient));
      inside.ws.close();
      mapped.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('503 without a connector, or when it refuses; 504 when it never answers; 410 to it then', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ acceptTimeoutMs: 300 }, logs);
    try {
      assert.equal(await client(url, 'prod'), 503, 'no connector');
      const refusing = asFake(await connector(url, 'prod', CONN, { mode: 'refuse' }));
      assert.equal(await client(url, 'prod'), 503, 'refused');
      assert.ok(logs.some((l) => l.why === 'connector refused busy' && l.status === 503 && l.mode === 'pair'));
      refusing.ws.close();
      await until(() => relay.connectors() === 0);

      const silent = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const t0 = Date.now();
      const late = held(url, 'prod');
      const s = await silent.session();
      assert.equal(await late, 504);
      assert.ok(Date.now() - t0 >= 250);
      assert.equal(relay.waiting(), 0);
      assert.equal(await acceptData(url, s.id, CONN), 410, 'the client is gone');
      assert.equal(await acceptData(url, s.id, CONN_B), 404, 'and to another token, nothing is said');
      silent.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('410 to the connector when the client left first; 503 when the connector goes away', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({}, logs);
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      // A client that gives up while the relay holds its upgrade.
      const quitter = new WebSocket(`${url}/v1/connect?name=prod`, [SUBPROTOCOL, `token.${CLIENT}`]);
      quitter.on('error', () => undefined);
      const s = await conn.session();
      assert.equal(relay.waiting(), 1);
      quitter.terminate();
      await until(() => relay.waiting() === 0);
      assert.ok(logs.some((l) => l.event === 'left' && l.name === 'prod'));
      assert.equal(await acceptData(url, s.id, CONN), 410);

      // The connector goes while a client waits.
      const waiting = held(url, 'prod');
      await conn.session();
      conn.ws.terminate();
      assert.equal(await waiting, 503);
      assert.ok(logs.some((l) => l.why === 'connector gone'));
      assert.ok(logs.some((l) => l.event === 'connector-down' && l.name === 'prod'));
    } finally {
      await relay.close();
    }
  });

  it('new sessions go to the oldest connector; a second one is logged with both addresses', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({}, logs);
    try {
      const first = asFake(await connector(url, 'prod', CONN, { mode: 'manual', from: '192.0.2.1' }));
      const second = asFake(await connector(url, 'prod', CONN_B, { mode: 'manual', from: '192.0.2.2' }));
      const dup = logs.find((l) => l.event === 'connector-duplicate')!;
      assert.equal(dup.connector, '192.0.2.2');
      assert.equal(dup.other, '192.0.2.1');
      assert.equal(dup.name, 'prod');
      // A third: refused, with when to try again (after two pings, when a stale one is gone).
      assert.equal(await connector(url, 'prod', CONN), 429);
      assert.equal(refusedHeaders['retry-after'], '60');

      const one = held(url, 'prod');
      const s1 = await first.session();
      // Only the connector the session went to may refuse it.
      second.ws.send(JSON.stringify({ t: 'refuse', id: s1.id, why: 'busy' }));
      // A type the relay doesn't know is ignored.
      first.ws.send(JSON.stringify({ t: 'something-new', x: 1 }));
      await sleep(50);
      assert.equal(relay.waiting(), 1);
      assert.ok(isWs(await acceptData(url, s1.id, CONN)));
      assert.ok(isWs(await one));
      assert.equal(second.queued(), 0, 'nothing went to the second');

      // The oldest goes: the next one takes over.
      first.ws.close();
      await until(() => relay.connectors() === 1);
      const two = held(url, 'prod');
      const s2 = await second.session();
      assert.ok(isWs(await acceptData(url, s2.id, CONN_B)));
      assert.ok(isWs(await two));
      second.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('caps the sessions of one name, waiting ones included', async () => {
    const { relay, url } = await startRelay({ maxPerName: 1 });
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const first = held(url, 'prod', { from: '198.51.100.1' });
      const s = await conn.session();
      assert.equal(await client(url, 'prod', { from: '198.51.100.2' }), 429, 'while the first waits');
      assert.ok(isWs(await acceptData(url, s.id, CONN)));
      const c = await first;
      assert.ok(isWs(c));
      assert.equal(await client(url, 'prod', { from: '198.51.100.3' }), 429, 'while the first is open');
      const done = closed(c);
      c.close();
      await done;
      await until(() => relay.open() === 0);
      const again = held(url, 'prod', { from: '198.51.100.4' });
      await conn.session();
      assert.equal(relay.waiting(), 1);
      void again;
    } finally {
      await relay.close();
    }
  });

  it('a waiting client counts against the relay and per-client caps, v1 included', async () => {
    const { relay, url } = await startRelay({ maxConnections: 1, targets: ['127.0.0.1:1'] });
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const first = held(url, 'prod', { from: '198.51.100.1' });
      await conn.session();
      assert.equal(await client(url, 'prod', { from: '198.51.100.2' }), 429);
      assert.equal(await dial(url, '/v1/ssh?target=127.0.0.1:1', [SUBPROTOCOL, `token.${V1}`], { from: '198.51.100.3' }), 429);
      void first;
    } finally {
      await relay.close();
    }
    const perClient = await startRelay({ maxPerClient: 1 });
    try {
      const conn = asFake(await connector(perClient.url, 'prod', CONN, { mode: 'manual' }));
      const first = held(perClient.url, 'prod', { from: '198.51.100.1' });
      await conn.session();
      assert.equal(await client(perClient.url, 'prod', { from: '198.51.100.1' }), 429);
      assert.notEqual(typeof (await connector(perClient.url, 'prod', CONN_B, { from: '198.51.100.1' })), 'number', 'connectors count per name, not per address');
      void first;
    } finally {
      await perClient.relay.close();
    }
  });

  it('new endpoints accept no Origin, their own, or a listed one; /v1/ssh keeps its rule', async () => {
    const { relay, url, port } = await startRelay({ targets: [`127.0.0.1:${sshdPort}`] });
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'accept', sshd: sshdPort }));
      for (const origin of [undefined, `http://127.0.0.1:${port}`, `https://127.0.0.1:${port}`]) {
        const c = await client(url, 'prod', { origin });
        assert.ok(isWs(c), String(origin));
        c.close();
      }
      for (const origin of ['https://evil.example', `http://127.0.0.1:${port + 1}`, 'null']) assert.equal(await client(url, 'prod', { origin }), 403, origin);
      assert.equal(await connector(url, 'prod', CONN_B, { origin: 'https://evil.example' }), 403);
      assert.equal(await acceptData(url, 'x', CONN, {}), 404, 'no Origin on the data socket: the id is checked');
      // v1, with RELAY_ORIGINS empty: any origin, as before.
      const v1 = await dial(url, `/v1/ssh?target=127.0.0.1:${sshdPort}`, [SUBPROTOCOL, `token.${V1}`], { origin: 'https://evil.example' });
      assert.ok(isWs(v1));
      v1.close();
      conn.ws.close();
    } finally {
      await relay.close();
    }
    const listed = await startRelay({ origins: ['https://app.example'] });
    try {
      asFake(await connector(listed.url, 'prod', CONN, { mode: 'accept', sshd: sshdPort }));
      const c = await client(listed.url, 'prod', { origin: 'https://app.example' });
      assert.ok(isWs(c));
      c.close();
      assert.equal(await client(listed.url, 'prod', { origin: 'https://evil.example' }), 403);
    } finally {
      await listed.relay.close();
    }
  });

  it('bounds what it queues both ways when one side stops reading', async () => {
    const { relay, url } = await startRelay();
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const pendingClient = held(url, 'prod');
      const s = await conn.session();
      const d = await acceptData(url, s.id, CONN);
      assert.ok(isWs(d));
      const c = await pendingClient;
      assert.ok(isWs(c));
      const frame = 256 << 10;
      const total = 32 << 20;
      for (const [from, to, name] of [
        [d, c, 'connector to client'],
        [c, d, 'client to connector'],
      ] as const) {
        to.pause();
        const parts: Buffer[] = [];
        let got = 0;
        const all = new Promise<void>((r) =>
          to.on('message', (b: Buffer) => {
            parts.push(b);
            got += b.length;
            if (got >= total) r();
          }),
        );
        for (let i = 0; i < total / frame; i++) from.send(Buffer.alloc(frame, i & 0xff));
        const before = relay.moved();
        let most = 0;
        for (let t = 0; t < 40; t++) {
          most = Math.max(most, relay.buffered());
          await sleep(25);
        }
        // The relay keeps about HIGH_WATER and a few frames, and stops reading the sender. What it
        // read beyond its queue sits in the kernel's buffers towards the paused reader. (The
        // sender's own queue says nothing on Windows: its sockets took all 160 MiB of a probe.)
        assert.ok(most <= HIGH_WATER + (2 << 20), `${name}: the relay queued ${most} bytes`);
        const read = relay.moved() - before;
        assert.ok(read < 12 << 20, `${name}: the relay read ${read} of ${total} bytes`);
        assert.equal(got, 0);
        to.resume();
        await all;
        const joined = Buffer.concat(parts);
        assert.equal(joined.length, total);
        for (let i = 0; i < total / frame; i++) assert.equal(joined[i * frame + 7], i & 0xff, `${name}: frame ${i}`);
        to.removeAllListeners('message');
      }
      c.close();
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('pings every socket: control, data and client, and cuts the one that misses a pong', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ pingIntervalMs: 100 }, logs);
    try {
      // A control socket that never answers.
      const deaf = asFake(await connector(url, 'edge', CONN_EDGE, { mode: 'manual', autoPong: false }));
      assert.equal(await deaf.closed, 1006);
      assert.ok(logs.some((l) => l.event === 'connector-down' && l.name === 'edge' && l.why === 'no pong'));

      // One that answers stays, across several pings.
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      await sleep(450);
      assert.equal(conn.ws.readyState, WebSocket.OPEN);

      // A data socket that never answers: the session ends, the client gets 1011.
      let pendingClient = held(url, 'prod');
      let s = await conn.session();
      const deafData = await acceptData(url, s.id, CONN, { autoPong: false });
      assert.ok(isWs(deafData));
      let c = await pendingClient;
      assert.ok(isWs(c));
      assert.equal(await closed(c), 1011);
      assert.ok(logs.some((l) => l.event === 'close' && l.why === 'connector no pong'));

      // A client that never answers: the connector's data socket gets 1011.
      pendingClient = client(url, 'prod', { autoPong: false });
      s = await conn.session();
      const d = await acceptData(url, s.id, CONN);
      assert.ok(isWs(d));
      c = await pendingClient;
      assert.ok(isWs(c));
      assert.equal(await closed(d), 1011);
      assert.ok(logs.some((l) => l.event === 'close' && l.mode === 'pair' && l.why === 'no pong'));
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('ends a pairing after its maximum lifetime, both sides with 1000', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ maxSessionMs: 300 }, logs);
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const pendingClient = held(url, 'prod');
      const s = await conn.session();
      const d = await acceptData(url, s.id, CONN);
      assert.ok(isWs(d));
      const c = await pendingClient;
      assert.ok(isWs(c));
      const busy = setInterval(() => c.readyState === WebSocket.OPEN && c.send(Buffer.from('x')), 20);
      const [a, b] = await Promise.all([closed(c), closed(d)]);
      clearInterval(busy);
      assert.deepEqual([a, b], [1000, 1000]);
      const close = logs.find((l) => l.event === 'close');
      assert.equal(close?.why, 'session lifetime');
      assert.ok(Number(close?.ms) >= 250);
      // The control socket is not a session: it stays.
      assert.equal(conn.ws.readyState, WebSocket.OPEN);
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('closes a control socket on anything but small JSON objects', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({}, logs);
    try {
      for (const [send, code] of [
        [(w: WebSocket) => w.send(Buffer.from('{"t":"refuse"}')), 1008],
        [(w: WebSocket) => w.send('not json'), 1008],
        [(w: WebSocket) => w.send('[1,2]'), 1008],
        [(w: WebSocket) => w.send('{"t":1}'), 1008],
        [(w: WebSocket) => w.send(JSON.stringify({ t: 'x', pad: 'y'.repeat(MAX_CONTROL_FRAME) })), 1009],
      ] as const) {
        const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
        await conn.hello;
        send(conn.ws);
        assert.equal(await conn.closed, code);
        await until(() => relay.connectors() === 0);
      }
      assert.ok(logs.some((l) => l.event === 'connector-down' && l.why === 'binary frame'));
      assert.ok(logs.some((l) => l.event === 'connector-down' && l.why === 'bad message'));
    } finally {
      await relay.close();
    }
  });

  it('a data socket that sends text ends the session', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({}, logs);
    try {
      const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
      const pendingClient = held(url, 'prod');
      const s = await conn.session();
      const d = await acceptData(url, s.id, CONN);
      assert.ok(isWs(d));
      const c = await pendingClient;
      assert.ok(isWs(c));
      const done = closed(c);
      d.send('text');
      assert.equal(await done, 1011);
      assert.ok(logs.some((l) => l.event === 'close' && l.why === 'connector text frame'));
      conn.ws.close();
    } finally {
      await relay.close();
    }
  });

  it('at shutdown: a waiting client gets 503, a connector 1001', async () => {
    const { relay, url } = await startRelay();
    const conn = asFake(await connector(url, 'prod', CONN, { mode: 'manual' }));
    const waiting = held(url, 'prod');
    await conn.session();
    await relay.close();
    assert.equal(await waiting, 503);
    assert.equal(await conn.closed, 1001);
  });

  it('without connectors, the pairing endpoints are off', async () => {
    const { relay, url } = await startRelay({ connectors: [], clients: [] });
    try {
      assert.equal(await client(url, 'prod', { token: V1 }), 404);
      assert.equal(await connector(url, 'prod', V1), 404);
      assert.equal(await acceptData(url, 'x', V1), 404);
    } finally {
      await relay.close();
    }
  });
});

describe('pairing settings', () => {
  let dir: string;
  before(() => (dir = mkdtempSync(join(tmpdir(), 'relay-pairing-'))));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it('reads the connectors and clients files', () => {
    const c = loadConfig({
      RELAY_CONNECTORS_FILE: file('c1', `# name token ranges\n\nprod ${CONN} 203.0.113.0/24,2001:db8::/32\r\nprod ${CONN_B}\nedge ${CONN_EDGE} 198.51.100.7\n`),
      RELAY_CLIENTS_FILE: file('k1', `${CLIENT} prod,edge\n  # a comment\n${V1}-other *\n`),
    });
    assert.deepEqual(c.connectors, [
      {
        name: 'prod',
        token: CONN,
        sources: [
          { address: '203.0.113.0', prefix: 24, family: 'ipv4' },
          { address: '2001:db8::', prefix: 32, family: 'ipv6' },
        ],
      },
      { name: 'prod', token: CONN_B, sources: [] },
      { name: 'edge', token: CONN_EDGE, sources: [{ address: '198.51.100.7', prefix: 32, family: 'ipv4' }] },
    ]);
    assert.deepEqual(c.clients, [
      { token: CLIENT, names: ['prod', 'edge'] },
      { token: `${V1}-other`, names: ['*'] },
    ]);
    // RELAY_TARGETS and RELAY_TOKEN are optional with connectors and clients.
    assert.deepEqual(c.targets, []);
    assert.deepEqual(c.tokens, []);
    assert.equal(c.maxPerName, 32);
    assert.equal(c.maxConnectorsPerName, 2);
    assert.equal(loadConfig({ RELAY_CONNECTORS_FILE: file('c2', `prod ${CONN}\n`), RELAY_TOKEN: V1, RELAY_ID: 'r1' }).relayId, 'r1');
  });

  it('refuses a token twice, across kinds, without saying it', () => {
    const conns = file('c3', `prod ${CONN}\n`);
    for (const env of [
      { RELAY_CONNECTORS_FILE: file('c4', `prod ${CONN}\nedge ${CONN}\n`), RELAY_TOKEN: V1 },
      { RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k2', `${CLIENT} prod\n${CLIENT} edge\n`) },
      { RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k3', `${V1} prod\n`), RELAY_TOKEN: V1 },
    ]) {
      let message = '';
      assert.throws(() => loadConfig(env), (e: Error) => ((message = e.message), /same token/.test(e.message)));
      for (const s of SECRETS) assert.ok(!message.includes(s), message);
    }
    // Repeats among the v1 variables worked before, and mean the same: still fine.
    assert.ok(loadConfig({ RELAY_TOKEN: V1, RELAY_TOKENS: V1, RELAY_TARGETS: 'a:22' }));
    // createRelay refuses it too, for a config built elsewhere.
    const base = loadConfig({ RELAY_CONNECTORS_FILE: conns, RELAY_TOKEN: V1 });
    assert.throws(() => createRelay({ ...base, clients: [{ token: CONN, names: ['*'] }] }, '0'), /twice/);
  });

  it('connector tokens start with mdrbc-, and no other token does', () => {
    assert.throws(() => loadConfig({ RELAY_CONNECTORS_FILE: file('c5', `prod ${V1}\n`), RELAY_TOKEN: CLIENT }), /must start with mdrbc-/);
    const conns = file('c6', `prod ${CONN}\n`);
    assert.throws(() => loadConfig({ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k4', `mdrbc-${CLIENT} prod\n`) }), /must not start with mdrbc-/);
    assert.throws(() => loadConfig({ RELAY_CONNECTORS_FILE: conns, RELAY_TOKEN: `mdrbc-${V1}` }), /connector's/);
  });

  it('refuses lines it cannot read, naming the line, never the token', () => {
    const conns = file('c7', `prod ${CONN}\n`);
    for (const [env, re] of [
      [{ RELAY_CONNECTORS_FILE: file('c8', `# c\nProd ${CONN}\n`), RELAY_TOKEN: V1 }, /line 2: "Prod" is not a name/],
      [{ RELAY_CONNECTORS_FILE: file('c9', `prod\n`), RELAY_TOKEN: V1 }, /line 1: expected/],
      [{ RELAY_CONNECTORS_FILE: file('c10', `prod mdrbc-short\n`), RELAY_TOKEN: V1 }, /line 1: the token must be at least 24/],
      [{ RELAY_CONNECTORS_FILE: file('c11', `prod ${CONN} 10.0.0.0/33\n`), RELAY_TOKEN: V1 }, /"10.0.0.0\/33" is not an address/],
      [{ RELAY_CONNECTORS_FILE: file('c12', `prod ${CONN} example.net\n`), RELAY_TOKEN: V1 }, /is not an address/],
      [{ RELAY_CONNECTORS_FILE: file('c13', `# nothing\n`), RELAY_TOKEN: V1 }, /names no connector/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k5', `${CLIENT}\n`) }, /RELAY_CLIENTS_FILE line 1: expected/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k6', `${CLIENT} prod,Bad\n`) }, /"Bad" is not a name/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k7', `${CLIENT} *,prod\n`) }, /"\*" is not a name/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k8', `${CLIENT}= prod\n`) }, /letters, digits/],
      [{ RELAY_CLIENTS_FILE: file('k9', `${CLIENT} prod\n`), RELAY_TARGETS: 'a:22', RELAY_TOKEN: V1 }, /needs RELAY_CONNECTORS_FILE/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_CLIENTS_FILE: file('k10', `${CLIENT} prod\n`), RELAY_TARGETS: 'a:22' }, /RELAY_TARGETS needs RELAY_TOKEN/],
      [{ RELAY_CONNECTORS_FILE: conns }, /RELAY_TOKEN/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_TOKEN: V1, RELAY_MAX_PER_NAME: '0' }, /RELAY_MAX_PER_NAME/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_TOKEN: V1, RELAY_MAX_CONNECTORS_PER_NAME: '0' }, /RELAY_MAX_CONNECTORS_PER_NAME/],
      [{ RELAY_CONNECTORS_FILE: conns, RELAY_TOKEN: V1, RELAY_MAX_PER_NAME: '2.5' }, /RELAY_MAX_PER_NAME/],
    ] as const) {
      let message = '';
      assert.throws(() => loadConfig(env), (e: Error) => ((message = e.message), re.test(e.message)), JSON.stringify(env));
      for (const s of SECRETS) assert.ok(!message.includes(s), message);
    }
  });
});

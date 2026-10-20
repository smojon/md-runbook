import { strict as assert } from 'node:assert';
import { AddressInfo, Server, createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { RelayConfig, isTargetSpec, loadConfig } from '../src/config';
import { LogEvent, Relay, SUBPROTOCOL, createRelay } from '../src/relay';

const TOKEN = 'a-test-token-of-at-least-24-chars';

/** A TCP server that answers every chunk with "echo:" + the chunk. */
function echoServer(): Promise<Server> {
  const s = createServer((sock) => sock.on('data', (b) => sock.write(Buffer.concat([Buffer.from('echo:'), b]))));
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const portOf = (s: { address(): unknown }): number => (s.address() as AddressInfo).port;

async function startRelay(over: Partial<RelayConfig>, logs: LogEvent[] = []): Promise<{ relay: Relay; url: string }> {
  const config: RelayConfig = {
    host: '127.0.0.1',
    port: 0,
    tokens: [TOKEN],
    targets: [],
    origins: [],
    maxConnections: 10,
    maxPerClient: 10,
    maxFailures: 3,
    failWindowMs: 60_000,
    trustProxy: false,
    connectTimeoutMs: 2000,
    pingIntervalMs: 30_000,
    ...over,
  };
  const relay = createRelay(config, '9.9.9', (e) => logs.push(e));
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  return { relay, url: `http://127.0.0.1:${portOf(relay.server)}` };
}

/** Opens a WebSocket; resolves with it, or with the HTTP status of the refusal. */
function open(url: string, target: string, opts: { token?: string; origin?: string; protocols?: string[]; path?: string } = {}): Promise<WebSocket | number> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}${opts.path ?? '/v1/ssh'}?target=${encodeURIComponent(target)}`, opts.protocols ?? [SUBPROTOCOL, `token.${opts.token ?? TOKEN}`], {
    origin: opts.origin,
  });
  ws.binaryType = 'nodebuffer';
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', reject);
  });
}

const nextMessage = (ws: WebSocket): Promise<Buffer> => new Promise((r) => ws.once('message', (d: Buffer) => r(d)));
const closed = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once('close', (code) => r(code)));

describe('relay', () => {
  let echo: Server;
  let target: string;
  before(async () => {
    echo = await echoServer();
    target = `127.0.0.1:${portOf(echo)}`;
  });
  after(() => echo.close());

  it('says which protocol it speaks, and is healthy', async () => {
    const { relay, url } = await startRelay({ targets: [target] });
    try {
      const r = await fetch(`${url}/v1/server-info`, { headers: { origin: 'https://app.example' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await r.json(), { name: 'md-runbook-relay', protocol: 1, version: '9.9.9', capabilities: ['ssh'] });
      assert.equal(await (await fetch(`${url}/healthz`)).text(), 'ok');
      assert.equal((await fetch(`${url}/`)).status, 404);
    } finally {
      await relay.close();
    }
  });

  it('copies bytes both ways and logs who reached what, never the data', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ targets: [target] }, logs);
    try {
      const ws = await open(url, target);
      assert.ok(ws instanceof WebSocket);
      assert.equal(ws.protocol, SUBPROTOCOL);
      const reply = nextMessage(ws);
      ws.send(Buffer.from('SSH-2.0-test\r\n'));
      assert.equal((await reply).toString(), 'echo:SSH-2.0-test\r\n');
      assert.equal(relay.open(), 1);
      const done = closed(ws);
      ws.close();
      await done;
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(relay.open(), 0);
      assert.deepEqual(
        logs.map((l) => l.event),
        ['open', 'close'],
      );
      assert.equal(logs[0]!.target, target);
      assert.ok(!JSON.stringify(logs).includes('SSH-2.0-test'));
      assert.equal(logs[1]!.up, 14);
    } finally {
      await relay.close();
    }
  });

  it('refuses a wrong token, a target not on the list, a foreign origin and an old protocol', async () => {
    const { relay, url } = await startRelay({ targets: [target], origins: ['https://app.example'], maxFailures: 100 });
    try {
      const origin = 'https://app.example';
      assert.equal(await open(url, target, { origin, token: 'x'.repeat(33) }), 401);
      assert.equal(await open(url, '127.0.0.1:22', { origin }), 403);
      assert.equal(await open(url, '10.0.0.1:' + portOf(echo), { origin }), 403);
      assert.equal(await open(url, target, { origin: 'https://evil.example' }), 403);
      assert.equal(await open(url, target), 403, 'no origin when an origin list is set');
      assert.equal(await open(url, target, { origin, protocols: ['mdrb-relay', `token.${TOKEN}`] }), 400);
      assert.equal(await open(url, target, { origin, path: '/ssh' }), 404);
      const ok = await open(url, target, { origin });
      assert.ok(ok instanceof WebSocket);
      ok.close();
    } finally {
      await relay.close();
    }
  });

  it('a client that fails the token check too often is refused for a while', async () => {
    const { relay, url } = await startRelay({ targets: [target], maxFailures: 3 });
    try {
      for (let i = 0; i < 3; i++) assert.equal(await open(url, target, { token: `wrong-token-number-${i}-padding` }), 401);
      assert.equal(await open(url, target), 429, 'even with the right token');
    } finally {
      await relay.close();
    }
  });

  it('caps connections per client', async () => {
    const { relay, url } = await startRelay({ targets: [target], maxPerClient: 1 });
    try {
      const first = await open(url, target);
      assert.ok(first instanceof WebSocket);
      assert.equal(await open(url, target), 429);
      first.close();
    } finally {
      await relay.close();
    }
  });

  it('closes the WebSocket when the SSH server cannot be reached', async () => {
    const gone = await echoServer();
    const port = portOf(gone);
    await new Promise((r) => gone.close(r));
    const { relay, url } = await startRelay({ targets: [`127.0.0.1:${port}`] });
    try {
      const ws = await open(url, `127.0.0.1:${port}`);
      assert.ok(ws instanceof WebSocket);
      assert.equal(await closed(ws), 1011);
    } finally {
      await relay.close();
    }
  });

  it('a wildcard host allows any host on that port only', async () => {
    const { relay, url } = await startRelay({ targets: [`*:${portOf(echo)}`] });
    try {
      const ws = await open(url, `localhost:${portOf(echo)}`);
      assert.ok(ws instanceof WebSocket);
      ws.close();
      assert.equal(await open(url, '127.0.0.1:1'), 403);
    } finally {
      await relay.close();
    }
  });
});

describe('relay settings', () => {
  const base = { RELAY_TOKEN: TOKEN, RELAY_TARGETS: 'web1.example.net:22' };
  it('needs a long token and an allowlist', () => {
    assert.throws(() => loadConfig({ RELAY_TARGETS: 'a:22' }), /RELAY_TOKEN/);
    assert.throws(() => loadConfig({ RELAY_TOKEN: 'short', RELAY_TARGETS: 'a:22' }), /24 characters/);
    assert.throws(() => loadConfig({ RELAY_TOKEN: TOKEN }), /RELAY_TARGETS/);
    assert.throws(() => loadConfig({ ...base, RELAY_TARGETS: 'web1' }), /not host:port/);
    assert.throws(() => loadConfig({ ...base, RELAY_PORT: 'x' }), /RELAY_PORT/);
  });

  it('reads the rest with safe defaults', () => {
    const c = loadConfig({ ...base, RELAY_TOKENS: `${TOKEN}-2, ${TOKEN}-3`, RELAY_ORIGINS: 'https://a.example, https://b.example' });
    assert.deepEqual(c.tokens, [`${TOKEN}-2`, `${TOKEN}-3`, TOKEN]);
    assert.deepEqual(c.origins, ['https://a.example', 'https://b.example']);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.trustProxy, false);
  });

  it('knows a target when it sees one', () => {
    for (const t of ['web1:22', 'a.b-c.example:2222', '10.0.0.1:22', '[::1]:22', '*:22']) assert.ok(isTargetSpec(t), t);
    for (const t of ['web1', ':22', 'web1:0', 'web1:70000', '*.example:22', 'a b:22']) assert.ok(!isTargetSpec(t), t);
  });
});

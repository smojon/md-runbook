import { strict as assert } from 'node:assert';
import { AddressInfo, Server, connect as connectTcp, createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { RelayConfig, isTargetSpec, loadConfig } from '../src/config';
import { LogEvent, Relay, SUBPROTOCOL, createRelay, isInternal } from '../src/relay';

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

  it('keeps serving when a refused client resets its connection (threat-model review, 2026-11-27)', async () => {
    const { relay, url } = await startRelay({ targets: [target], maxFailures: 5 });
    try {
      // A session that is open before, and must still work after.
      const ws = await open(url, target);
      assert.ok(ws instanceof WebSocket);
      const port = portOf(relay.server);
      // Wrong path (404), wrong token (401), then too many failures (429); the reset lands
      // before, during and after the refusal is written.
      for (const path of ['/nope', '/v1/ssh'])
        for (let i = 0; i < 15; i++)
          await new Promise<void>((resolve) => {
            const s = connectTcp(port, '127.0.0.1', () => {
              s.write(
                `GET ${path}?target=${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                  `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}, token.wrong-token-of-24-characters\r\n\r\n`,
              );
              setTimeout(() => s.resetAndDestroy(), i % 3 === 0 ? 0 : i % 3 === 1 ? 5 : 20);
              setTimeout(resolve, 30);
            });
            s.on('error', () => resolve());
          });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      const reply = nextMessage(ws);
      ws.send(Buffer.from('still here'));
      assert.equal((await reply).toString(), 'echo:still here');
      ws.close();
    } finally {
      await relay.close();
    }
  });

  it('answers 400 to a URL it cannot read, as an upgrade or a plain request, and keeps serving', async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ targets: [target] }, logs);
    try {
      const ws = await open(url, target);
      assert.ok(ws instanceof WebSocket);
      const port = portOf(relay.server);
      // `new URL` throws on each of these; a throw in a handler used to end the relay.
      const raw = (path: string, upgrade: boolean): Promise<string> =>
        new Promise((resolve) => {
          let got = '';
          const s = connectTcp(port, '127.0.0.1', () =>
            s.write(
              `GET ${path} HTTP/1.1\r\nHost: x\r\n` +
                (upgrade
                  ? `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n`
                  : 'Connection: close\r\n') +
                '\r\n',
            ),
          );
          s.on('data', (d) => (got += d.toString()));
          s.on('close', () => resolve(got));
          s.on('error', () => resolve(got));
        });
      for (const path of ['//[', 'http://[', 'http://a:b@/', 'http://%/'])
        for (const upgrade of [true, false]) assert.match(await raw(path, upgrade), /^HTTP\/1\.1 400 /, `${path} upgrade=${upgrade}`);
      assert.ok(logs.some((e) => e.event === 'refused' && e.why === 'url'));
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      const reply = nextMessage(ws);
      ws.send(Buffer.from('still here'));
      assert.equal((await reply).toString(), 'echo:still here');
      ws.close();
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

  it("a wildcard host allows that port only, and never the relay's own or a private network", async () => {
    const logs: LogEvent[] = [];
    const { relay, url } = await startRelay({ targets: [`*:${portOf(echo)}`] }, logs);
    try {
      assert.equal(await open(url, '127.0.0.1:1'), 403);
      assert.equal(await open(url, `127.0.0.1:${portOf(echo)}`), 403);
      assert.equal(await open(url, `[::1]:${portOf(echo)}`), 403);
      // Other spellings of loopback: an IP literal never goes through the DNS lookup below.
      for (const literal of ['0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:127.0.0.1'])
        assert.equal(await open(url, `[${literal}]:${portOf(echo)}`), 403, literal);
      // A name that resolves to an internal address: the connection is refused at lookup.
      const ws = await open(url, `localhost:${portOf(echo)}`);
      assert.ok(ws instanceof WebSocket);
      await new Promise((r) => ws.on('close', r));
      assert.ok(logs.some((l) => l.event === 'close' && /internal address|EINTERNAL/.test(String(l.why))), JSON.stringify(logs));
    } finally {
      await relay.close();
    }
    // Listed by name or address, an internal server is fine: the operator chose it.
    const listed = await startRelay({ targets: [`*:22`, target] });
    try {
      const ws = await open(listed.url, target);
      assert.ok(ws instanceof WebSocket);
      ws.close();
    } finally {
      await listed.relay.close();
    }
  });

  it('knows internal addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1',
      // Other spellings of loopback and private addresses (security review, 2026-11-16).
      '0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:0:127.0.0.1', '64:ff9b::a00:1', '::127.0.0.1', '2002:7f00:1::',
      '198.18.0.1', '224.0.0.1', '255.255.255.255', '192.0.0.1', 'ff02::1', '2001:db8::1', 'fec0::1', '203.0.113.9'])
      assert.ok(isInternal(a), a);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2a00:1450:4001::1', '::ffff:8.8.8.8', '2606:4700::1111', 'not-an-address']) assert.ok(!isInternal(a), a);
  });

  it('NAT64: judged by the IPv4 address it embeds, so a DNS64-only relay reaches public hosts', () => {
    // Public IPv4 hosts through the well-known prefix, and the /96 form of the local-use one.
    for (const a of ['64:ff9b::808:808', '64:ff9b::8.8.8.8', '64:ff9b:0:0:0:0:808:808', '64:FF9B::0808:0808', '64:ff9b:1::808:808', '64:ff9b:1::1.1.1.1'])
      assert.ok(!isInternal(a), a);
    // Internal IPv4 addresses behind them; and another layout of 64:ff9b:1::/48, which can't be told.
    for (const a of ['64:ff9b::a00:1', '64:ff9b::10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:101', '64:ff9b::',
      '64:ff9b:1::a00:1', '64:ff9b:1::192.168.1.1', '64:ff9b:1:a00:1::808:808', '64:ff9b:1:abcd::808:808'])
      assert.ok(isInternal(a), a);
    // The rest of 64:ff9b::/32, whatever it embeds: refused (security review, round 4).
    for (const a of ['64:ff9b:a00:1::', '64:ff9b::ffff:a00:1', '64:ff9b::ffff:10.0.0.1', '64:ff9b::1:a00:1', '64:ff9b:0:a00:1::', '64:ff9b:2::a00:1',
      '64:ff9b::1:808:808', '64:ff9b:808:808::', '64:ff9b:ffff::808:808'])
      assert.ok(isInternal(a), a);
  });
});

describe('relay settings', () => {
  const base = { RELAY_TOKEN: TOKEN, RELAY_TARGETS: 'web1.example.net:22' };
  it('needs a long token and an allowlist', () => {
    assert.throws(() => loadConfig({ RELAY_TARGETS: 'a:22' }), /RELAY_TOKEN/);
    assert.throws(() => loadConfig({ RELAY_TOKEN: 'short', RELAY_TARGETS: 'a:22' }), /24 characters/);
    // `openssl rand -base64 32` ends in `=` (and may hold `/`): a browser can't send it as a subprotocol.
    assert.throws(() => loadConfig({ ...base, RELAY_TOKEN: 'Ht5pbLsPrEFKnJgUIeF11FeqLmtGZr9Vtra0t93U5O4=' }), /openssl rand -hex 32/);
    assert.throws(() => loadConfig({ ...base, RELAY_TOKENS: `${TOKEN}/x` }), /letters, digits/);
    assert.ok(loadConfig({ ...base, RELAY_TOKEN: 'b04d6752122db1e60570b22f6eb68c93f9fb013f4466962cc33ea0c125920c43' }));
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

import { strict as assert } from 'node:assert';
import { generateKeyPairSync, verify } from 'node:crypto';
import * as fs from 'node:fs';
import { IncomingMessage, createServer } from 'node:http';
import { Http2ServerRequest, createServer as createH2Server } from 'node:http2';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Firing } from '../src/alerts';
import { AlertsConfig, FcmConfig, PushConfig, loadConfig, parseServiceAccount } from '../src/config';
import { Devices, REFUSED_TO_PRUNE, deviceId, parseRegistration, tokenDigest, wants } from '../src/devices';
import { HttpError } from '../src/http';
import { ApnsSender, FcmSender, MAX_LINK, PushService, SendResult, jwt, pushMessage } from '../src/push';
import { call, config, start, tok } from './helpers';

const DEVICES = 'devices-token-of-at-least-24-chars';
const OTHER = 'another-token-of-at-least-24-chars';
const AM = 'alertmanager-token-of-at-least-24';
const IOS_TOKEN = 'a'.repeat(64);
const IOS_GONE = 'b'.repeat(64);
const IOS_BAD = 'd'.repeat(64);
const ANDROID_TOKEN = 'fcm-token-' + 'x'.repeat(150);
const ANDROID_GONE = 'fcm-token-' + 'y'.repeat(150);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (k: { export(o: { type: 'pkcs8'; format: 'pem' }): string | Buffer }): string => String(k.export({ type: 'pkcs8', format: 'pem' }));
const decode = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

const firing = (over: Partial<Firing> = {}): Firing => ({
  received: '2026-11-16T10:00:00Z',
  status: 'firing',
  alertname: 'KubePodCrashLooping',
  fingerprint: '5f3c9e',
  labels: { alertname: 'KubePodCrashLooping', namespace: 'prod-eu', secret_label: 'do-not-send' },
  runbook: 'k8s/crashloop.md',
  link: 'https://runbooks.example.net/open?url=https%3A%2F%2Frunbooks.example.net%2Frunbooks%2Fk8s%2Fcrashloop.md&p.NAMESPACE=prod-eu',
  ...over,
});

const body = async (req: IncomingMessage | Http2ServerRequest): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

describe('push: settings', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-pushcfg-'));
    fs.writeFileSync(path.join(dir, 'map.json'), '{"routes":[]}');
    fs.writeFileSync(path.join(dir, 'AuthKey.p8'), pem(ec.privateKey));
    fs.writeFileSync(path.join(dir, 'rsa.p8'), pem(rsa.privateKey));
    fs.writeFileSync(
      path.join(dir, 'sa.json'),
      JSON.stringify({ type: 'service_account', project_id: 'md-runbook-test', client_email: 'push@md-runbook-test.iam.gserviceaccount.com', private_key: pem(rsa.privateKey) }),
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = (): NodeJS.ProcessEnv => ({ ALERT_MAP: path.join(dir, 'map.json'), PUBLIC_URL: 'https://runbooks.example.net', ALERTS_TOKENS: AM, STATE_DIR: dir });

  it('off without a sender; a device token without one is refused', () => {
    assert.equal(loadConfig(base()).push, undefined);
    assert.throws(() => loadConfig({ ...base(), DEVICES_TOKENS: DEVICES }), /no push sender/);
  });

  it('APNs: the .p8 key, key ID, team ID; the topic defaults to the bundle ID', () => {
    const env: NodeJS.ProcessEnv = { ...base(), PUSH_APNS_KEY_FILE: path.join(dir, 'AuthKey.p8'), PUSH_APNS_KEY_ID: 'ABC123DEFG', PUSH_APNS_TEAM_ID: 'DEF123GHIJ', DEVICES_TOKENS: DEVICES };
    const p = loadConfig(env).push!;
    assert.deepEqual([p.apns!.topic, p.apns!.sandbox, p.fcm, p.tokens.length, p.file], ['dev.mdrunbook.app', false, undefined, 1, path.join(path.resolve(dir), 'devices.json')]);
    assert.throws(() => loadConfig({ ...env, PUSH_APNS_KEY_ID: 'short' }), /PUSH_APNS_KEY_ID/);
    assert.throws(() => loadConfig({ ...env, PUSH_APNS_KEY_FILE: path.join(dir, 'rsa.p8') }), /EC P-256/);
    // Without DEVICES_TOKENS: the alerts' read tokens; with none of those either, refused.
    assert.throws(() => loadConfig({ ...env, DEVICES_TOKENS: '' }), /DEVICES_TOKENS/);
    assert.equal(loadConfig({ ...env, DEVICES_TOKENS: '', RUNS_READ_TOKENS: OTHER }).push!.tokens[0]!.value, OTHER);
    assert.throws(() => loadConfig({ ...env, ALERT_MAP: undefined, RUNS_DIR: dir }), /need ALERT_MAP/);
  });

  it('FCM: a service account key file', () => {
    const p = loadConfig({ ...base(), PUSH_FCM_SERVICE_ACCOUNT_FILE: path.join(dir, 'sa.json'), DEVICES_TOKENS: DEVICES }).push!;
    assert.deepEqual([p.fcm!.projectId, p.fcm!.tokenUri, p.apns], ['md-runbook-test', 'https://oauth2.googleapis.com/token', undefined]);
    assert.throws(() => parseServiceAccount('{"type":"authorized_user"}'), /not a service account/);
    assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'p-1234', client_email: 'x', private_key: pem(ec.privateKey) })), /not an RSA key/);
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'p-1234', client_email: 'x', private_key: pem(rsa.privateKey), token_uri: 'http://evil' })),
      /https/,
    );
  });
});

describe('push: tokens and messages', () => {
  it('JWTs: RS256 for Google, ES256 (r||s, as JOSE wants) for Apple', () => {
    const g = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'a', iat: 1 }, rsa.privateKey).split('.');
    assert.ok(verify('sha256', Buffer.from(`${g[0]}.${g[1]}`), rsa.publicKey, Buffer.from(g[2]!, 'base64url')));
    const a = jwt({ alg: 'ES256', kid: 'ABC123DEFG' }, { iss: 'DEF123GHIJ', iat: 2 }, ec.privateKey).split('.');
    assert.deepEqual([decode(a[0]!), decode(a[1]!)], [{ alg: 'ES256', kid: 'ABC123DEFG' }, { iss: 'DEF123GHIJ', iat: 2 }]);
    assert.equal(Buffer.from(a[2]!, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${a[0]}.${a[1]}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(a[2]!, 'base64url')));
  });

  it('a push says the alert, its runbook and carries its link; no labels', () => {
    const m = pushMessage(firing());
    assert.deepEqual(m, { title: 'KubePodCrashLooping firing', body: 'Tap to open k8s/crashloop.md', link: firing().link, alertname: 'KubePodCrashLooping', fingerprint: '5f3c9e' });
    assert.ok(!JSON.stringify(m).includes('do-not-send'));
    const long = pushMessage(firing({ link: `https://runbooks.example.net/open?url=x&p.X=${'a'.repeat(MAX_LINK)}` }));
    assert.deepEqual([long.link, long.body], [undefined, 'k8s/crashloop.md: the link is too long for a push']);
  });

  it('registrations: platform and token checked, filters too', () => {
    assert.deepEqual(parseRegistration(JSON.stringify({ platform: 'ios', token: IOS_TOKEN })), { platform: 'ios', token: IOS_TOKEN });
    assert.throws(() => parseRegistration(JSON.stringify({ platform: 'ios', token: 'not-hex' })), /APNs device token/);
    assert.throws(() => parseRegistration(JSON.stringify({ platform: 'web', token: IOS_TOKEN })), /platform/);
    assert.throws(() => parseRegistration(JSON.stringify({ platform: 'android', token: ANDROID_TOKEN, extra: 1 })), /unknown field/);
    assert.throws(() => parseRegistration(JSON.stringify({ platform: 'android', token: ANDROID_TOKEN, runbooks: ['../x.md'] })), /runbooks/);
    const r = parseRegistration(JSON.stringify({ platform: 'android', token: ANDROID_TOKEN, alertnames: ['A', 'A'], runbooks: ['k8s/', 'db/restore.md'] }));
    assert.deepEqual([r.alertnames, r.runbooks], [['A'], ['k8s/', 'db/restore.md']]);
    const d = { id: 'x', platform: 'android' as const, token: ANDROID_TOKEN, by: 't', registered: '', updated: '' };
    assert.ok(wants(d, firing()));
    assert.ok(wants({ ...d, runbooks: ['k8s/'] }, firing()));
    assert.ok(!wants({ ...d, runbooks: ['db/'] }, firing()));
    assert.ok(!wants({ ...d, alertnames: ['DiskFull'] }, firing()));
  });

  it('devices: kept in one file, mode 600; re-registering updates; capped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-devices-'));
    try {
      const file = path.join(dir, 'state', 'devices.json');
      const devices = new Devices(file, 2);
      const a = await devices.register({ platform: 'ios', token: IOS_TOKEN }, tok(DEVICES, 'team'));
      assert.deepEqual([a.created, a.device.id], [true, deviceId('ios', IOS_TOKEN)]);
      const again = await devices.register({ platform: 'ios', token: IOS_TOKEN, alertnames: ['A'] }, tok(DEVICES, 'team'));
      assert.deepEqual([again.created, again.device.registered, again.device.alertnames], [false, a.device.registered, ['A']]);
      await devices.register({ platform: 'android', token: ANDROID_TOKEN }, tok(DEVICES, 'team'));
      await assert.rejects(devices.register({ platform: 'android', token: ANDROID_GONE }, tok(DEVICES, 'team')), /at most 2 devices/);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal((await new Devices(file, 2).list()).length, 2, 'read back from the file');
      assert.equal(await devices.remove([a.device.id, 'f'.repeat(32)]), 1);
      assert.deepEqual(
        (await new Devices(file, 2).list()).map((d) => d.platform),
        ['android'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('push: one token holder', () => {
  const ios = (n: number): string => n.toString(16).padStart(64, '0');

  it('may register at most PUSH_MAX_DEVICES_PER_TOKEN devices; updating one of them is fine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-pertoken-'));
    try {
      const devices = new Devices(path.join(dir, 'devices.json'), 100, 2);
      await devices.register({ platform: 'ios', token: ios(1) }, tok(DEVICES, 'phones'));
      await devices.register({ platform: 'ios', token: ios(2) }, tok(DEVICES, 'phones'));
      await assert.rejects(devices.register({ platform: 'ios', token: ios(3) }, tok(DEVICES, 'phones')), /PUSH_MAX_DEVICES_PER_TOKEN/);
      // The same token's devices again (new filters): not a new device.
      assert.equal((await devices.register({ platform: 'ios', token: ios(2), alertnames: ['A'] }, tok(DEVICES, 'phones'))).created, false);
      // Another token has its own allowance.
      assert.equal((await devices.register({ platform: 'ios', token: ios(3) }, tok(OTHER, 'other'))).created, true);
      // Not even under the old label: the count is per token.
      await assert.rejects(devices.register({ platform: 'ios', token: ios(4) }, tok(DEVICES, 'renamed')), /PUSH_MAX_DEVICES_PER_TOKEN/);
      // Another token can't re-register this token's phone.
      await assert.rejects(devices.register({ platform: 'ios', token: ios(1) }, tok(OTHER, 'other')), (e: HttpError) => e.status === 409);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can take over a phone only when the token it registered with isn't accepted any more", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-takeover-'));
    try {
      const file = path.join(dir, 'devices.json');
      await new Devices(file, 100).register({ platform: 'ios', token: ios(1) }, tok(OTHER, 'old'));
      const now = new Devices(file, 100, 50, new Set([tokenDigest(DEVICES)]));
      const r = await now.register({ platform: 'ios', token: ios(1) }, tok(DEVICES, 'phones'));
      assert.deepEqual([r.created, r.device.tokenDigest, r.device.by], [false, tokenDigest(DEVICES), 'phones']);
      const strict = new Devices(file, 100, 50, new Set([tokenDigest(DEVICES), tokenDigest(OTHER)]));
      await assert.rejects(strict.register({ platform: 'ios', token: ios(1) }, tok(OTHER, 'old')), (e: HttpError) => e.status === 409);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a token the provider refuses 3 pushes in a row is removed, only while other phones get them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-refused-'));
    try {
      const devices = new Devices(path.join(dir, 'devices.json'), 100);
      let goodOk = true;
      const send = async (token: string): Promise<SendResult> => (token === ios(1) && goodOk ? { ok: true } : { ok: false, why: 'APNs: HTTP 400 BadDeviceToken', refused: true });
      const cfg = { file: devices.file, tokens: [tok(DEVICES, 'phones')], maxDevices: 100, maxDevicesPerToken: 50, repeatMs: 0 };
      const service = new PushService(cfg, devices, { ios: { send } }, () => {});
      const ids = async (): Promise<string[]> => (await devices.list()).map((d) => d.token).sort();
      await devices.register({ platform: 'ios', token: ios(1) }, tok(DEVICES, 'phones'));
      await devices.register({ platform: 'ios', token: ios(2) }, tok(DEVICES, 'phones'));
      const round = async (n: number): Promise<void> => {
        await service.notify(firing({ fingerprint: `fp-refused-${n}` }));
        await service.idle();
      };
      // Every iPhone refused (a wrong PUSH_APNS_SANDBOX looks like this): nobody counts a strike.
      goodOk = false;
      for (let n = 0; n < REFUSED_TO_PRUNE + 1; n++) await round(n);
      assert.deepEqual(await ids(), [ios(1), ios(2)]);
      assert.deepEqual((await devices.list()).map((d) => d.refused), [undefined, undefined]);
      // The good one gets them: the refused one is removed after 3 in a row.
      goodOk = true;
      for (let n = 10; n < 10 + REFUSED_TO_PRUNE - 1; n++) await round(n);
      assert.deepEqual(await ids(), [ios(1), ios(2)]);
      await round(20);
      assert.deepEqual(await ids(), [ios(1)]);
      // A push that goes through clears the count.
      await devices.register({ platform: 'ios', token: ios(2) }, tok(DEVICES, 'phones'));
      await devices.settle([], [deviceId('ios', ios(2))], []);
      assert.equal((await devices.list()).find((d) => d.token === ios(2))!.refused, 1);
      await devices.settle([], [], [deviceId('ios', ios(2))]);
      assert.equal((await devices.list()).find((d) => d.token === ios(2))!.refused, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fake Google: the token endpoint and FCM's send, answering per token. */
async function fakeFcm(): Promise<{ url: string; sent: any[]; assertions: string[]; tokensIssued: () => number; expireNext: () => void; close(): Promise<void> }> {
  const sent: any[] = [];
  const assertions: string[] = [];
  let issued = 0;
  let expire = false;
  const server = createServer(async (req, res) => {
    const text = await body(req);
    if (req.url === '/token') {
      const q = new URLSearchParams(text);
      assert.equal(q.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertions.push(q.get('assertion')!);
      issued++;
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600, token_type: 'Bearer' }));
    }
    assert.equal(req.url, '/v1/projects/md-runbook-test/messages:send');
    if (expire) {
      expire = false;
      return void res.writeHead(401).end('{}');
    }
    const msg = JSON.parse(text);
    sent.push({ auth: req.headers.authorization, ...msg });
    if (msg.message.token === ANDROID_GONE)
      return void res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'projects/md-runbook-test/messages/1' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    assertions,
    tokensIssued: () => issued,
    expireNext: () => (expire = true),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A fake APNs on cleartext HTTP/2. */
async function fakeApns(): Promise<{ url: string; sent: any[]; expireNext: () => void; close(): Promise<void> }> {
  const sent: any[] = [];
  let expire = false;
  const server = createH2Server(async (req, res) => {
    const text = await body(req);
    if (expire) {
      expire = false;
      return void res.writeHead(403, { 'content-type': 'application/json' }).end('{"reason":"ExpiredProviderToken"}');
    }
    sent.push({ path: req.url, headers: req.headers, payload: JSON.parse(text) });
    if (req.url === `/3/device/${IOS_GONE}`) return void res.writeHead(410, { 'content-type': 'application/json' }).end('{"reason":"Unregistered","timestamp":1}');
    if (req.url === `/3/device/${IOS_BAD}`) return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"reason":"BadDeviceToken"}');
    res.writeHead(200, { 'apns-id': 'x' }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent, expireNext: () => (expire = true), close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('push: alerts to phones', () => {
  let dir: string;
  let fcm: Awaited<ReturnType<typeof fakeFcm>>;
  let apns: Awaited<ReturnType<typeof fakeApns>>;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-push-'));
    fs.writeFileSync(
      path.join(dir, 'alert-map.json'),
      JSON.stringify({ routes: [{ alertname: 'KubePodCrashLooping', runbook: 'k8s/crashloop.md', params: { NAMESPACE: '{{ $labels.namespace }}' } }] }),
    );
    [fcm, apns] = await Promise.all([fakeFcm(), fakeApns()]);
  });
  after(async () => {
    await Promise.all([fcm.close(), apns.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fcmConfig = (): FcmConfig => ({ projectId: 'md-runbook-test', clientEmail: 'push@md-runbook-test.iam.gserviceaccount.com', privateKey: pem(rsa.privateKey), tokenUri: `${fcm.url}/token` });
  const apnsConfig = { key: pem(ec.privateKey), keyId: 'ABC123DEFG', teamId: 'DEF123GHIJ', topic: 'dev.mdrunbook.app', sandbox: true };
  const alerts = (): AlertsConfig => ({
    map: path.join(dir, 'alert-map.json'),
    dir: path.join(dir, 'alerts'),
    tokens: [tok(AM, 'alertmanager')],
    readTokens: [],
    publicUrl: 'https://runbooks.example.net',
    libraryPath: '/runbooks/',
    maxBytes: 64 * 1024,
  });
  const push = (over: Partial<PushConfig> = {}): PushConfig => ({
    file: path.join(dir, 'state', 'devices.json'),
    tokens: [tok(DEVICES, 'phones'), tok(OTHER, 'old')],
    fcm: fcmConfig(),
    apns: apnsConfig,
    maxDevices: 100,
    maxDevicesPerToken: 50,
    repeatMs: 3_600_000,
    ...over,
  });
  const webhook = (fingerprint: string): string =>
    JSON.stringify({
      version: '4',
      receiver: 'md-runbook',
      alerts: [{ status: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'prod-eu', secret_label: 'do-not-send' }, annotations: { summary: 'secret annotation' }, fingerprint }],
    });

  it('registers phones, pushes a firing alert to each, removes the tokens the providers say are gone', async () => {
    const senders = { android: new FcmSender(fcmConfig(), { endpoint: fcm.url }), ios: new ApnsSender(apnsConfig, { origin: apns.url }) };
    const { s, url, logs } = await start(config(dir, { alerts: alerts(), push: push() }), { senders });
    try {
      const reg = (b: unknown, token?: string) => call(`${url}/v1/devices`, 'POST', JSON.stringify(b), token);
      assert.equal((await reg({ platform: 'ios', token: IOS_TOKEN })).status, 401);
      assert.equal((await reg({ platform: 'ios', token: IOS_TOKEN }, AM)).status, 401, "Alertmanager's token can't register");
      assert.equal((await reg({ platform: 'ios', token: 'zz' }, DEVICES)).status, 400);
      const r = await reg({ platform: 'ios', token: IOS_TOKEN }, DEVICES);
      assert.deepEqual([r.status, r.json], [201, { id: deviceId('ios', IOS_TOKEN), platform: 'ios' }]);
      assert.equal((await reg({ platform: 'ios', token: IOS_TOKEN }, DEVICES)).status, 200);
      for (const [platform, token] of [
        ['ios', IOS_GONE],
        ['android', ANDROID_TOKEN],
        ['android', ANDROID_GONE],
      ])
        assert.equal((await reg({ platform, token }, DEVICES)).status, 201);
      // Only for DiskFull: not pushed this KubePodCrashLooping.
      assert.equal((await reg({ platform: 'android', token: 'fcm-token-' + 'z'.repeat(150), alertnames: ['DiskFull'] }, DEVICES)).status, 201);
      // Registered with another accepted token (withdrawn in the next test).
      assert.equal((await reg({ platform: 'ios', token: 'c'.repeat(64) }, OTHER)).status, 201);
      // Another accepted token can't re-register (mute, take over) a phone: 409, filters kept.
      assert.equal((await reg({ platform: 'ios', token: IOS_TOKEN, alertnames: ['Nothing'] }, OTHER)).status, 409);
      assert.equal((await s.push!.devices.list()).find((d) => d.token === IOS_TOKEN)!.alertnames, undefined);

      const posted = await call(`${url}/v1/alerts`, 'POST', webhook('fp-1'), AM);
      assert.deepEqual(posted.json, { recorded: 1, linked: 1 });
      await s.push!.idle();

      // Android: a data message as expo-notifications reads it.
      assert.equal(fcm.sent.length, 2, 'the two Android phones for this alert (one of them gone), not the DiskFull one');
      const m = fcm.sent.find((x) => x.message.token === ANDROID_TOKEN)!;
      assert.equal(m.auth, 'Bearer access-1');
      assert.deepEqual(Object.keys(m.message.data).sort(), ['body', 'channelId', 'message', 'title']);
      assert.equal(m.message.data.title, 'KubePodCrashLooping firing');
      assert.equal(m.message.data.channelId, 'alerts');
      const data = JSON.parse(m.message.data.body);
      assert.equal(data.kind, 'alert');
      assert.ok(data.link.startsWith('https://runbooks.example.net/open?url='));
      assert.match(data.link, /p\.NAMESPACE=prod-eu/);
      assert.equal(m.message.android.priority, 'HIGH');
      // Google's assertion: RS256, the messaging scope, for the token endpoint.
      const [h, c] = fcm.assertions[0]!.split('.');
      assert.equal(decode(h!).alg, 'RS256');
      assert.deepEqual([decode(c!).scope, decode(c!).aud, decode(c!).exp - decode(c!).iat], ['https://www.googleapis.com/auth/firebase.messaging', `${fcm.url}/token`, 3600]);

      // iPhone: HTTP/2 to /3/device/<token>, a provider token, the bundle ID as topic.
      assert.deepEqual(apns.sent.map((x) => x.path).sort(), [`/3/device/${IOS_TOKEN}`, `/3/device/${IOS_GONE}`, `/3/device/${'c'.repeat(64)}`].sort());
      const a = apns.sent.find((x) => x.path === `/3/device/${IOS_TOKEN}`)!;
      assert.deepEqual([a.headers['apns-topic'], a.headers['apns-push-type'], a.headers['apns-priority'], a.headers['apns-collapse-id']], ['dev.mdrunbook.app', 'alert', '10', 'fp-1']);
      assert.match(a.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      assert.deepEqual(a.payload.aps.alert, { title: 'KubePodCrashLooping firing', body: 'Tap to open k8s/crashloop.md' });
      assert.equal(a.payload.body.link, data.link);
      // Nothing of the labels or annotations but what the alert map put in the link.
      for (const x of [...fcm.sent, ...apns.sent]) assert.ok(!/do-not-send|secret annotation|secret_label/.test(JSON.stringify(x)));

      // The gone ones are removed; the others stay.
      const left = (await s.push!.devices.list()).map((d) => d.token);
      assert.ok(left.includes(IOS_TOKEN) && left.includes(ANDROID_TOKEN));
      assert.ok(!left.includes(IOS_GONE) && !left.includes(ANDROID_GONE));
      const log = logs.find((e) => e.event === 'push')!;
      assert.deepEqual([log.sent, log.failed, log.pruned], [3, 2, 2]);

      // The same alert again (Alertmanager's repeat): not pushed again within PUSH_REPEAT_SECONDS.
      const before = fcm.sent.length + apns.sent.length;
      await call(`${url}/v1/alerts`, 'POST', webhook('fp-1'), AM);
      await s.push!.idle();
      assert.equal(fcm.sent.length + apns.sent.length, before);
      assert.ok(logs.some((e) => e.event === 'push-repeat'));

      // An expired access token / provider token: renewed once and sent.
      fcm.expireNext();
      apns.expireNext();
      await call(`${url}/v1/alerts`, 'POST', webhook('fp-2'), AM);
      await s.push!.idle();
      assert.equal(fcm.tokensIssued(), 2);
      assert.equal(logs.filter((e) => e.event === 'push').pop()!.failed, 0);

      // Unregister.
      const id = deviceId('android', ANDROID_TOKEN);
      assert.equal((await call(`${url}/v1/devices/${id}`, 'DELETE')).status, 401);
      assert.equal((await call(`${url}/v1/devices/not-an-id`, 'DELETE', undefined, DEVICES)).status, 400);
      // Another accepted token can't take this phone off: it isn't the one it registered with.
      assert.equal((await call(`${url}/v1/devices/${id}`, 'DELETE', undefined, OTHER)).status, 404);
      assert.deepEqual((await call(`${url}/v1/devices/${id}`, 'DELETE', undefined, DEVICES)).json, { deleted: id });
      assert.equal((await call(`${url}/v1/devices/${id}`, 'DELETE', undefined, DEVICES)).status, 404);
      assert.ok(!logs.some((e) => JSON.stringify(e).includes(IOS_TOKEN) || JSON.stringify(e).includes(DEVICES)), 'tokens are never logged');
    } finally {
      await s.close();
    }
  });

  it("a withdrawn device token's phones get no pushes; a platform without a sender is refused", async () => {
    const senders = { ios: new ApnsSender(apnsConfig, { origin: apns.url }) };
    // Only "phones" now: the phone registered with "old" above gets nothing.
    const { s, url } = await start(config(dir, { alerts: alerts(), push: push({ tokens: [tok(DEVICES, 'phones')], fcm: undefined }) }), { senders });
    try {
      assert.equal((await call(`${url}/v1/devices`, 'POST', JSON.stringify({ platform: 'android', token: ANDROID_TOKEN }), DEVICES)).status, 400);
      apns.sent.length = 0;
      await call(`${url}/v1/alerts`, 'POST', webhook('fp-3'), AM);
      await s.push!.idle();
      assert.deepEqual(
        apns.sent.map((x) => x.path),
        [`/3/device/${IOS_TOKEN}`],
      );
      assert.ok((await call(`${url}/v1/server-info`, 'GET')).json.capabilities.includes('push'));
      // The phone of the withdrawn token: an accepted token may register it again.
      assert.equal((await call(`${url}/v1/devices`, 'POST', JSON.stringify({ platform: 'ios', token: 'c'.repeat(64) }), DEVICES)).status, 200);
    } finally {
      await s.close();
    }
  });

  it("APNs BadDeviceToken: the phone is removed after 3 pushes in a row that reached the others", async () => {
    const senders = { ios: new ApnsSender(apnsConfig, { origin: apns.url }) };
    const { s, url } = await start(config(dir, { alerts: alerts(), push: push({ tokens: [tok(DEVICES, 'phones')], fcm: undefined }) }), { senders });
    try {
      assert.equal((await call(`${url}/v1/devices`, 'POST', JSON.stringify({ platform: 'ios', token: IOS_BAD }), DEVICES)).status, 201);
      const tokens = async (): Promise<string[]> => (await s.push!.devices.list()).map((d) => d.token);
      for (let n = 1; n <= REFUSED_TO_PRUNE; n++) {
        assert.ok((await tokens()).includes(IOS_BAD), `still there before push ${n}`);
        await s.push!.notify(firing({ fingerprint: `fp-bad-${n}` }));
        await s.push!.idle();
      }
      assert.ok(!(await tokens()).includes(IOS_BAD));
      assert.ok((await tokens()).includes(IOS_TOKEN));
    } finally {
      await s.close();
    }
  });

  it('a devices token replaced under the same label: the phones of the old one get no pushes', async () => {
    const senders = { ios: new ApnsSender(apnsConfig, { origin: apns.url }) };
    // "phones" is now another token: the iPhone registered with the old one gets nothing.
    const { s } = await start(config(dir, { alerts: alerts(), push: push({ tokens: [tok('rotated-token-of-at-least-24-chars', 'phones')], fcm: undefined }) }), { senders });
    try {
      assert.ok((await s.push!.devices.list()).some((d) => d.token === IOS_TOKEN && d.by === 'phones'));
      apns.sent.length = 0;
      await s.push!.notify(firing({ fingerprint: 'fp-rotated' }));
      await s.push!.idle();
      assert.deepEqual(apns.sent, []);
    } finally {
      await s.close();
    }
  });

  it('without push settings /v1/devices is not there', async () => {
    const { s, url } = await start(config(dir, { alerts: alerts() }));
    try {
      assert.equal((await call(`${url}/v1/devices`, 'POST', '{}', DEVICES)).status, 404);
    } finally {
      await s.close();
    }
  });
});

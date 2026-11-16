/**
 * Firing alerts as pushes to the phones registered for them (devices.ts): Android through
 * Firebase Cloud Messaging (HTTP v1), iPhones through APNs (token-based, HTTP/2). Both with
 * node:crypto and node:http2 only, no Google or Apple SDK.
 *
 * - FCM: the service account's key signs an OAuth2 assertion (JWT, RS256), exchanged at its
 *   token_uri for an access token (an hour), sent as `Authorization: Bearer` to
 *   POST https://fcm.googleapis.com/v1/projects/<project>/messages:send.
 * - APNs: the .p8 key signs a provider token (JWT, ES256: kid, iss = team ID, iat), renewed
 *   every 40 minutes (Apple: no more than every 20, no less than every 60), sent on one HTTP/2
 *   connection to api.push.apple.com (or api.sandbox.push.apple.com) as POST /3/device/<token>.
 *
 * A push carries the alert's name, its runbook's path and the alert's link (the one
 * /v1/alerts/recent lists: the runbook's address and hash, and the parameters the alert map
 * fills in). Nothing else: no labels or annotations beyond those, no token, no secret.
 * The provider sees what a push carries.
 *
 * Tokens the provider says are gone (FCM 404 / UNREGISTERED, APNs 410) are removed. Pushes are
 * sent after the webhook is answered, one alert at a time, so a slow provider never holds up
 * Alertmanager; a failure is logged.
 */
import { KeyObject, createPrivateKey, sign } from 'node:crypto';
import { ClientHttp2Session, connect, constants as h2 } from 'node:http2';
import type { Firing } from './alerts';
import type { ApnsConfig, FcmConfig, PushConfig } from './config';
import { Device, DevicePlatform, Devices, tokenDigest, wants } from './devices';
import type { LogEvent } from './http';

export interface PushMessage {
  title: string;
  body: string;
  /** The alert's /open?url=…&sha256=… link; absent when too long for a push. */
  link?: string;
  alertname: string;
  fingerprint?: string;
}

export type SendResult = { ok: true } | { ok: false; why: string; /** The provider says the token is gone: remove the device. */ gone?: boolean };

export interface Sender {
  send(token: string, m: PushMessage): Promise<SendResult>;
  close?(): void;
}

/** APNs and FCM take 4 KB; the link is left out above this (the rest is small). */
export const MAX_LINK = 3000;
const TIMEOUT_MS = 10_000;

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** A compact JWT signed with `key` (RS256 or ES256, the signature as JOSE wants it: r||s for ES256). */
export function jwt(header: Record<string, string>, claims: Record<string, string | number>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = sign('sha256', Buffer.from(input), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${input}.${b64url(sig)}`;
}

/** What a firing alert's push says. */
export function pushMessage(f: Firing): PushMessage {
  const name = f.alertname || 'An alert';
  const link = f.link && f.link.length <= MAX_LINK ? f.link : undefined;
  const body = !f.link ? 'No runbook' : link ? `Tap to open ${f.runbook ?? 'its runbook'}` : `${f.runbook ?? 'Its runbook'}: the link is too long for a push`;
  return { title: `${name} firing`.slice(0, 200), body: body.slice(0, 300), ...(link ? { link } : {}), alertname: name.slice(0, 200), ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}) };
}

/** What the app reads on a tap (notification data): Expo hands it over as `content.data`. */
const appData = (m: PushMessage): Record<string, string> => ({ kind: 'alert', alertname: m.alertname, ...(m.link ? { link: m.link } : {}) });

/** The Android channel the app makes for alerts (an unknown one falls back to Expo's default). */
export const ANDROID_CHANNEL = 'alerts';

export class FcmSender implements Sender {
  private readonly key: KeyObject;
  private access?: { token: string; until: number };
  private fetching?: Promise<string>;

  constructor(
    private readonly cfg: FcmConfig,
    private readonly opts: { endpoint?: string; now?: () => number } = {},
  ) {
    this.key = createPrivateKey(cfg.privateKey);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * An access token: the cached one while it has more than a minute left and isn't `stale` (the
   * one FCM just refused); else a new one, a single request for all the sends waiting on it.
   */
  private accessToken(stale?: string): Promise<string> {
    if (this.access && this.access.token !== stale && this.access.until - 60_000 > this.now()) return Promise.resolve(this.access.token);
    return (this.fetching ??= this.newAccessToken().finally(() => (this.fetching = undefined)));
  }

  private async newAccessToken(): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const assertion = jwt(
      { alg: 'RS256', typ: 'JWT' },
      { iss: this.cfg.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.cfg.tokenUri, iat, exp: iat + 3600 },
      this.key,
    );
    const r = await fetch(this.cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!r.ok || typeof j.access_token !== 'string') throw new Error(`FCM: no access token (HTTP ${r.status}${typeof j.error === 'string' ? ` ${j.error}` : ''})`);
    const seconds = typeof j.expires_in === 'number' ? j.expires_in : 3600;
    this.access = { token: j.access_token, until: this.now() + seconds * 1000 };
    return j.access_token;
  }

  async send(token: string, m: PushMessage): Promise<SendResult> {
    // A data message, as expo-notifications wants it on Android: it shows `title` and `message`
    // and hands `body` (JSON) to the app as the notification's data.
    const message = {
      message: {
        token,
        data: { title: m.title, message: m.body, body: JSON.stringify(appData(m)), channelId: ANDROID_CHANNEL },
        android: { priority: 'HIGH', ttl: '3600s', ...(m.fingerprint ? { collapse_key: m.fingerprint.slice(0, 64) } : {}) },
      },
    };
    const url = `${this.opts.endpoint ?? 'https://fcm.googleapis.com'}/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`;
    const post = (access: string): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    const access = await this.accessToken();
    let r = await post(access);
    // Refused (revoked, expired early): a new token, once.
    if (r.status === 401) r = await post(await this.accessToken(access));
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
    const code = j.error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? j.error?.status ?? '';
    const why = `FCM: HTTP ${r.status}${code ? ` ${code}` : ''}`;
    // UNREGISTERED (404): the app was removed or the token replaced. Not any 404 (a wrong project
    // says that too), and INVALID_ARGUMENT only when it is about the token: a setting or payload
    // problem must never remove every device.
    const gone = code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /registration token/i.test(j.error?.message ?? ''));
    return { ok: false, why, ...(gone ? { gone } : {}) };
  }
}

export class ApnsSender implements Sender {
  private readonly key: KeyObject;
  private provider?: { token: string; at: number };
  private session?: ClientHttp2Session;

  constructor(
    private readonly cfg: ApnsConfig,
    private readonly opts: { origin?: string; now?: () => number } = {},
  ) {
    this.key = createPrivateKey(cfg.key);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private providerToken(fresh = false): string {
    if (!fresh && this.provider && this.now() - this.provider.at < 40 * 60_000) return this.provider.token;
    const at = this.now();
    this.provider = { token: jwt({ alg: 'ES256', kid: this.cfg.keyId }, { iss: this.cfg.teamId, iat: Math.floor(at / 1000) }, this.key), at };
    return this.provider.token;
  }

  private connection(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const origin = this.opts.origin ?? (this.cfg.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    const s = connect(origin);
    const drop = (): void => {
      if (this.session === s) this.session = undefined;
    };
    s.on('error', drop);
    s.on('close', drop);
    s.on('goaway', drop);
    // The connection never keeps the process up; an hour idle closes it.
    s.unref();
    s.setTimeout(60 * 60_000, () => s.close());
    this.session = s;
    return s;
  }

  private request(token: string, body: string, fresh: boolean, m: PushMessage): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const s = this.connection();
      const req = s.request({
        [h2.HTTP2_HEADER_METHOD]: 'POST',
        [h2.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${this.providerToken(fresh)}`,
        'apns-topic': this.cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(this.now() / 1000) + 3600),
        ...(m.fingerprint ? { 'apns-collapse-id': m.fingerprint.slice(0, 64) } : {}),
        'content-type': 'application/json',
      });
      req.setTimeout(TIMEOUT_MS, () => req.close(h2.NGHTTP2_CANCEL));
      let status = 0;
      const chunks: Buffer[] = [];
      req.on('response', (h) => (status = Number(h[h2.HTTP2_HEADER_STATUS])));
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { reason?: unknown };
          if (typeof j.reason === 'string') reason = j.reason;
        } catch {
          // no body
        }
        resolve({ status, ...(reason ? { reason } : {}) });
      });
      req.on('error', reject);
      req.on('close', () => {
        if (status === 0) reject(new Error('APNs: no answer'));
      });
      req.end(body);
    });
  }

  async send(token: string, m: PushMessage): Promise<SendResult> {
    // Expo hands `body` to the app as the notification's data.
    const body = JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: 'default', 'thread-id': 'alerts' }, body: appData(m) });
    let r = await this.request(token, body, false, m);
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') r = await this.request(token, body, true, m);
    if (r.status === 200) return { ok: true };
    // 410: Unregistered, ExpiredToken. Not BadDeviceToken (400): a sandbox token sent to production
    // (PUSH_APNS_SANDBOX wrong) says that too, and would remove every iPhone.
    return { ok: false, why: `APNs: HTTP ${r.status}${r.reason ? ` ${r.reason}` : ''}`, ...(r.status === 410 ? { gone: true } : {}) };
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }
}

/** Runs `tasks` with at most `n` at a time. */
async function pool<T>(items: readonly T[], n: number, task: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await task(items[next++]!);
    }),
  );
}

export type Senders = Partial<Record<DevicePlatform, Sender>>;

export class PushService {
  private queue: Promise<void> = Promise.resolve();
  /** When each alert (fingerprint, else link) was last pushed. */
  private readonly pushed = new Map<string, number>();
  /** Digests of the devices tokens accepted now: a device gets pushes only under one of them. */
  private readonly digests: Set<string>;

  constructor(
    readonly config: PushConfig,
    readonly devices: Devices,
    readonly senders: Senders,
    private readonly log: (e: LogEvent) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.digests = new Set(config.tokens.map((t) => tokenDigest(t.value)));
  }

  /** The platforms this server can push to. */
  platforms(): DevicePlatform[] {
    return (['ios', 'android'] as const).filter((p) => this.senders[p]);
  }

  /** The Notify of Alerts: queues the push and returns (the webhook is answered at once). */
  readonly notify = async (f: Firing): Promise<void> => {
    this.queue = this.queue.then(() =>
      this.push(f).catch((e: unknown) => this.log({ event: 'push-failed', alertname: f.alertname, why: e instanceof Error ? e.message : String(e) })),
    );
  };

  /** Resolves once every queued push is sent (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async push(f: Firing): Promise<void> {
    const key = f.fingerprint ?? f.link ?? f.alertname;
    const t = this.now();
    for (const [k, at] of this.pushed) if (t - at >= this.config.repeatMs) this.pushed.delete(k);
    if (this.pushed.has(key)) return void this.log({ event: 'push-repeat', alertname: f.alertname, fingerprint: f.fingerprint });
    this.pushed.set(key, t);
    const m = pushMessage(f);
    const list = (await this.devices.list()).filter((d) => this.senders[d.platform] && d.tokenDigest !== undefined && this.digests.has(d.tokenDigest) && wants(d, f));
    const gone: Device[] = [];
    let sent = 0;
    const failures: string[] = [];
    await pool(list, 20, async (d) => {
      const r = await this.senders[d.platform]!.send(d.token, m).catch((e: unknown): SendResult => ({ ok: false, why: e instanceof Error ? e.message : String(e) }));
      if (r.ok) sent++;
      else {
        failures.push(r.why);
        if (r.gone) gone.push(d);
      }
    });
    const pruned = await this.devices.remove(gone.map((d) => d.id));
    this.log({ event: 'push', alertname: f.alertname, fingerprint: f.fingerprint, devices: list.length, sent, failed: failures.length, pruned, why: failures[0] });
  }

  close(): void {
    for (const s of Object.values(this.senders)) s?.close?.();
  }
}

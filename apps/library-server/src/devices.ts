/**
 * The phones that get firing alerts as pushes: each registered with POST /v1/devices (a device
 * token) and its native push token (APNs on iPhones, FCM on Android). Kept in one JSON file in
 * STATE_DIR, mode 600, written atomically; the server is its only writer.
 *
 * A device only gets pushes while the token it registered with is still one the server accepts:
 * taking a token out of DEVICES_TOKENS stops its phones too. The device keeps a digest of that
 * token, not its label: a new token under the old label doesn't bring the old phones back.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { Firing } from './alerts';
import { HttpError, Mutex } from './http';
import { pathProblem, writeAtomic } from './library';

export type DevicePlatform = 'ios' | 'android';

export interface Device {
  /** sha256(platform:token), 32 hex characters: what DELETE /v1/devices/<id> names. */
  id: string;
  platform: DevicePlatform;
  /** The native push token (an APNs device token, an FCM registration token). */
  token: string;
  /** Only these alerts (by alertname); absent: all. */
  alertnames?: string[];
  /** Only alerts whose runbook is one of these library paths, or below one ending in "/"; absent: all. */
  runbooks?: string[];
  /** The label of the device token it registered with (for the log). */
  by: string;
  /** sha256 of the device token it registered with: it gets pushes while that token is accepted. */
  tokenDigest?: string;
  /** Pushes in a row the provider refused this token for (APNs BadDeviceToken): removed at 3. */
  refused?: number;
  registered: string;
  updated: string;
}

export interface Registration {
  platform: DevicePlatform;
  token: string;
  alertnames?: string[];
  runbooks?: string[];
}

// APNs: the device token's bytes in hex (32 bytes today; Apple says its length may change).
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,512}$/;
// FCM: a registration token (about 160 characters of base64url and ":" today).
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{32,4096}$/;
const ALERTNAME_RE = /^[^\x00-\x1f]{1,200}$/;
export const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
/** A device whose token the provider refused this many pushes in a row is removed. */
export const REFUSED_TO_PRUNE = 3;
const MAX_FILTERS = 50;

/** What a device keeps of the devices token it registered with (never the token). */
export const tokenDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export const deviceId = (platform: DevicePlatform, token: string): string => createHash('sha256').update(`${platform}:${token}`).digest('hex').slice(0, 32);

const filterList = (x: unknown, name: string, ok: (s: string) => string | undefined): string[] | undefined => {
  if (x === undefined || x === null) return undefined;
  if (!Array.isArray(x) || x.length > MAX_FILTERS || x.some((s) => typeof s !== 'string')) throw new HttpError(400, `${name}: expected at most ${MAX_FILTERS} names`);
  for (const s of x as string[]) {
    const why = ok(s);
    if (why) throw new HttpError(400, `${name}: ${why}`);
  }
  return x.length > 0 ? [...new Set(x as string[])] : undefined;
};

/** A registration's body: `{"platform":"ios"|"android","token":"…","alertnames":[…]?,"runbooks":[…]?}`. */
export function parseRegistration(json: string): Registration {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'not JSON');
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new HttpError(400, 'expected {"platform": "ios" or "android", "token": …}');
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['platform', 'token', 'alertnames', 'runbooks'].includes(k)) throw new HttpError(400, `unknown field "${k}"`);
  if (o.platform !== 'ios' && o.platform !== 'android') throw new HttpError(400, 'platform: "ios" or "android"');
  if (typeof o.token !== 'string' || !(o.platform === 'ios' ? APNS_TOKEN_RE : FCM_TOKEN_RE).test(o.token))
    throw new HttpError(400, o.platform === 'ios' ? 'token: the APNs device token, in hex' : 'token: the FCM registration token');
  const alertnames = filterList(o.alertnames, 'alertnames', (s) => (ALERTNAME_RE.test(s) ? undefined : `${JSON.stringify(s.slice(0, 40))} is not an alert name`));
  const runbooks = filterList(o.runbooks, 'runbooks', (s) => {
    const p = s.endsWith('/') ? `${s}x.md` : s;
    const why = pathProblem(p);
    return why ? `${JSON.stringify(s.slice(0, 80))}: ${why}` : undefined;
  });
  return { platform: o.platform, token: o.token, ...(alertnames ? { alertnames } : {}), ...(runbooks ? { runbooks } : {}) };
}

/** Whether `d` asked for this alert (its filters). */
export function wants(d: Device, f: Firing): boolean {
  if (d.alertnames && !d.alertnames.includes(f.alertname)) return false;
  if (d.runbooks && !(f.runbook && d.runbooks.some((r) => (r.endsWith('/') ? f.runbook!.startsWith(r) : f.runbook === r)))) return false;
  return true;
}

const isDevice = (d: unknown): d is Device => {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return typeof o.id === 'string' && (o.platform === 'ios' || o.platform === 'android') && typeof o.token === 'string' && typeof o.by === 'string';
};

export class Devices {
  private readonly lock = new Mutex();
  private devices: Device[] | undefined;

  constructor(
    readonly file: string,
    readonly maxDevices: number,
    /** Most devices one devices token may register: one token's holder can't fill the list. */
    readonly maxPerToken = 50,
    /**
     * Digests of the devices tokens the server accepts now. A phone registered under one of them
     * can't be taken over by another token. Absent: every digest counts as accepted.
     */
    readonly accepted?: ReadonlySet<string>,
  ) {}

  private async load(): Promise<Device[]> {
    if (this.devices) return this.devices;
    let text: string;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return (this.devices = []);
    }
    const x = JSON.parse(text) as { devices?: unknown };
    this.devices = Array.isArray(x.devices) ? x.devices.filter(isDevice) : [];
    return this.devices;
  }

  private async save(list: Device[]): Promise<void> {
    await fsp.mkdir(dirname(this.file), { recursive: true, mode: 0o750 });
    await writeAtomic(this.file, JSON.stringify({ version: 1, devices: list }, null, 1) + '\n', 0o600);
    this.devices = list;
  }

  /** The registered devices (a copy). */
  async list(): Promise<Device[]> {
    return this.lock.run(async () => [...(await this.load())]);
  }

  /**
   * Adds the device, or updates it (its filters) when its token is registered already. Only the
   * devices token it registered with may update it (409 for another one), unless that token is
   * no longer accepted: another token's holder can't mute or take over a phone.
   */
  async register(r: Registration, by: { label: string; value: string }, now = new Date()): Promise<{ device: Device; created: boolean }> {
    return this.lock.run(async () => {
      const list = await this.load();
      const id = deviceId(r.platform, r.token);
      const old = list.find((d) => d.id === id);
      if (!old && list.length >= this.maxDevices) throw new HttpError(507, `this server keeps at most ${this.maxDevices} devices (PUSH_MAX_DEVICES)`);
      const digest = tokenDigest(by.value);
      if (old?.tokenDigest !== undefined && old.tokenDigest !== digest && (this.accepted?.has(old.tokenDigest) ?? true))
        throw new HttpError(409, 'this phone is registered with another devices token: update or remove it with that token');
      if (old?.tokenDigest !== digest && list.filter((d) => d.tokenDigest === digest).length >= this.maxPerToken)
        throw new HttpError(507, `this devices token has registered ${this.maxPerToken} devices, the most it may (PUSH_MAX_DEVICES_PER_TOKEN)`);
      const at = now.toISOString();
      const device: Device = {
        id,
        platform: r.platform,
        token: r.token,
        ...(r.alertnames ? { alertnames: r.alertnames } : {}),
        ...(r.runbooks ? { runbooks: r.runbooks } : {}),
        by: by.label,
        tokenDigest: digest,
        registered: old?.registered ?? at,
        updated: at,
      };
      await this.save([...list.filter((d) => d.id !== id), device]);
      return { device, created: !old };
    });
  }

  /**
   * DELETE /v1/devices/<id>: removes the device only for the devices token it registered with.
   * Whether it was removed (false: no such device, or another token's).
   */
  async removeOwn(id: string, by: { value: string }): Promise<boolean> {
    return this.lock.run(async () => {
      const list = await this.load();
      const digest = tokenDigest(by.value);
      const kept = list.filter((d) => !(d.id === id && d.tokenDigest === digest));
      if (kept.length === list.length) return false;
      await this.save(kept);
      return true;
    });
  }

  /**
   * After a push: removes the devices the provider says are gone, counts the pushes in a row it
   * refused a device's token for (removed at REFUSED_TO_PRUNE), and clears that count on a push
   * that went through. How many were removed.
   */
  async settle(gone: readonly string[], refused: readonly string[], ok: readonly string[]): Promise<number> {
    if (gone.length + refused.length === 0 && ok.length === 0) return 0;
    return this.lock.run(async () => {
      const list = await this.load();
      let changed = false;
      const kept: Device[] = [];
      for (const d of list) {
        if (gone.includes(d.id)) {
          changed = true;
          continue;
        }
        if (refused.includes(d.id)) {
          changed = true;
          const n = (d.refused ?? 0) + 1;
          if (n >= REFUSED_TO_PRUNE) continue;
          kept.push({ ...d, refused: n });
          continue;
        }
        if (ok.includes(d.id) && d.refused !== undefined) {
          changed = true;
          const { refused: _, ...rest } = d;
          kept.push(rest);
          continue;
        }
        kept.push(d);
      }
      if (changed) await this.save(kept);
      return list.length - kept.length;
    });
  }

  /** Removes the devices; how many were there. */
  async remove(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.lock.run(async () => {
      const list = await this.load();
      const kept = list.filter((d) => !ids.includes(d.id));
      if (kept.length !== list.length) await this.save(kept);
      return list.length - kept.length;
    });
  }
}

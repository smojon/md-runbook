/**
 * Alerts on this phone: the team library server (apps/library-server, on the library's own
 * address) pushes its firing alerts to the phones registered with POST /v1/devices. The phone
 * sends its native push token (APNs or FCM, not Expo's push service) with the devices token the
 * user enters, kept in the Keychain / Keystore. A tap opens the alert's link through the link
 * opening every other link goes through (runbooks/openLink.ts): its sha256 pin, the library's
 * rules, Only signed links. A push never runs anything.
 *
 * Only a build with push set up can register: Firebase's google-services.json (Android) or the
 * APNs entitlement (iOS) are in the build only when app.config.js found them
 * (`extra.push.<platform>`). Elsewhere the switch says "Not set up in this build".
 */
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';
import { t } from '../i18n';
import { openRunbookLink } from '../runbooks/openLink';
import { getJson, setJson } from '../storage/kv';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';
import * as platform from './platform';
import { devicePushToken, onPushToken, prepareAlertChannel } from './pushToken';

export type PushPlatform = 'ios' | 'android';

/** This phone, as registered with the library server. */
export interface AlertRegistration {
  /** The server's origin (the team library's): https://runbooks.example.net */
  server: string;
  /** The id the server answered (DELETE /v1/devices/<id>). */
  id: string;
  platform: PushPlatform;
  /** The push token registered (a new one is registered again). */
  pushToken: string;
}

const KEY = 'alertPush.v1';
/** Before tokens were kept per server: the token of the one registration then. */
const LEGACY_SECRET = 'alertPush.devicesToken';

/** The secure-storage key of a server's devices token (keys allow only [A-Za-z0-9._-]). */
export function devicesTokenKey(server: string): string {
  const hex = [...new TextEncoder().encode(server)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${LEGACY_SECRET}.${hex}`;
}

/** The devices token `server` accepted, or null: never another server's. */
async function tokenOf(server: string): Promise<string | null> {
  const own = await getSecret(devicesTokenKey(server)).catch(() => null);
  if (own) return own;
  // Kept before tokens were per server: it belongs to the registration of then.
  return current?.server === server ? getSecret(LEGACY_SECRET).catch(() => null) : null;
}

async function forgetToken(server: string): Promise<void> {
  await deleteSecret(devicesTokenKey(server)).catch(() => undefined);
}

const isRegistration = (x: unknown): x is AlertRegistration => {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.server === 'string' &&
    typeof o.id === 'string' &&
    (o.platform === 'ios' || o.platform === 'android') &&
    typeof o.pushToken === 'string'
  );
};

let current: AlertRegistration | undefined;
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function loadAlertPush(): Promise<void> {
  return (loaded ??= getJson(KEY, isRegistration).then((r) => {
    current = r;
    emit();
  }));
}

async function save(r: AlertRegistration | undefined): Promise<void> {
  current = r;
  emit();
  await setJson(KEY, r ?? null);
}

export function alertRegistration(): AlertRegistration | undefined {
  return current;
}

export function useAlertRegistration(): AlertRegistration | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Whether this build can register: `ok`, or why not (the web has no pushes at all). */
export function alertPushSupport(): 'ok' | 'web' | 'not-in-build' {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'web';
  const push = (Constants.expoConfig?.extra as { push?: Record<string, unknown> } | undefined)?.push;
  return push?.[Platform.OS] === true ? 'ok' : 'not-in-build';
}

/** The library server's origin, from the team library's address (https only). */
export function serverOf(libraryBase: string | undefined): string | undefined {
  if (!libraryBase) return undefined;
  try {
    const u = new URL(libraryBase);
    return u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export type Outcome = { ok: true } | { ok: false; message: string; blocked?: boolean };

/** The server's own words for a refusal (`{"error": …}`), else its status. */
async function refusal(r: Response): Promise<string> {
  const j = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof j?.error === 'string' ? j.error.slice(0, 300) : `HTTP ${r.status}`;
}

async function register(
  server: string,
  devicesToken: string,
  pushToken: string,
  p: PushPlatform,
  fetcher: typeof fetch,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  let r: Response;
  try {
    r = await fetcher(`${server}/v1/devices`, {
      method: 'POST',
      headers: { authorization: `Bearer ${devicesToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: p, token: pushToken }),
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) return { ok: false, message: await refusal(r) };
  const j = (await r.json().catch(() => undefined)) as { id?: unknown } | undefined;
  return typeof j?.id === 'string' && /^[0-9a-f]{32}$/.test(j.id) ? { ok: true, id: j.id } : { ok: false, message: t.alertPushBadAnswer };
}

async function unregister(server: string, id: string, devicesToken: string, fetcher: typeof fetch): Promise<Outcome> {
  try {
    const r = await fetcher(`${server}/v1/devices/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${devicesToken}` } });
    return r.ok || r.status === 404 ? { ok: true } : { ok: false, message: await refusal(r) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Turn alerts on for the team library at `libraryBase`: the permission, the token, the registration. */
export async function turnOnAlertPush(
  libraryBase: string | undefined,
  devicesToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Outcome> {
  if (alertPushSupport() !== 'ok') return { ok: false, message: t.alertPushNotInBuild };
  const server = serverOf(libraryBase);
  if (!server) return { ok: false, message: t.alertPushNoLibrary };
  const token = devicesToken.trim();
  if (token === '') return { ok: false, message: t.alertPushNeedToken };
  if ((await platform.requestPermission()) !== 'granted') return { ok: false, message: t.alertPushBlocked, blocked: true };
  await prepareAlertChannel();
  let pushToken: string;
  try {
    pushToken = await devicePushToken();
  } catch (e) {
    return { ok: false, message: t.alertPushFailed(e instanceof Error ? e.message : String(e)) };
  }
  const p: PushPlatform = Platform.OS === 'ios' ? 'ios' : 'android';
  const r = await register(server, token, pushToken, p, fetcher);
  if (!r.ok) return { ok: false, message: t.alertPushFailed(r.message) };
  // Another registration before (the library moved): that one stops too, with its own server's
  // token only. This server's token never goes to another one.
  const before = current;
  const beforeToken = before ? await tokenOf(before.server) : null;
  await setSecret(devicesTokenKey(server), token);
  await deleteSecret(LEGACY_SECRET).catch(() => undefined);
  await save({ server, id: r.id, platform: p, pushToken });
  if (before && before.server === server && before.id !== r.id) void unregister(server, before.id, beforeToken ?? token, fetcher);
  else if (before && before.server !== server) {
    const gone = beforeToken ? unregister(before.server, before.id, beforeToken, fetcher) : Promise.resolve();
    void gone.then(() => forgetToken(before.server));
  }
  return { ok: true };
}

/** Turn alerts off: forgotten here at once, then the server is told. */
export async function turnOffAlertPush(fetcher: typeof fetch = fetch): Promise<Outcome> {
  await loadAlertPush();
  const reg = current;
  if (!reg) return { ok: true };
  const token = await tokenOf(reg.server);
  await save(undefined);
  await forgetToken(reg.server);
  await deleteSecret(LEGACY_SECRET).catch(() => undefined);
  if (!token) return { ok: true };
  const r = await unregister(reg.server, reg.id, token, fetcher);
  return r.ok ? r : { ok: false, message: t.alertPushOffFailed(r.message) };
}

/**
 * The link a tap opens: only an alert's (`kind: "alert"`), only an https /open link on the
 * registered server's own origin. Anything else is ignored.
 */
export function alertLinkOf(data: Record<string, unknown>, reg: AlertRegistration | undefined): string | undefined {
  if (!reg || data.kind !== 'alert' || typeof data.link !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(data.link);
  } catch {
    return undefined;
  }
  return u.protocol === 'https:' && u.origin === reg.server && /\/open\/?$/.test(u.pathname) ? data.link : undefined;
}

/** A tap on an alert's push: its runbook opens, or why it can't. */
export async function openAlertTap(data: Record<string, unknown>, fetcher?: typeof fetch): Promise<void> {
  if (data.kind !== 'alert') return;
  await loadAlertPush();
  const link = alertLinkOf(data, current);
  if (!link) return;
  const r = await openRunbookLink(link, fetcher);
  if (r.kind === 'opened') router.push({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
  else Alert.alert(t.alertPushOpenFailedTitle, r.message);
}

/** A push token other than the registered one (rolled by the provider): registered again. */
export async function refreshAlertPush(newToken?: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (alertPushSupport() !== 'ok') return;
  await loadAlertPush();
  const reg = current;
  if (!reg) return;
  const pushToken = newToken ?? (await devicePushToken().catch(() => undefined));
  if (!pushToken || pushToken === reg.pushToken) return;
  const token = await tokenOf(reg.server);
  if (!token) return;
  const r = await register(reg.server, token, pushToken, reg.platform, fetcher);
  if (!r.ok) return;
  await save({ ...reg, id: r.id, pushToken });
  if (r.id !== reg.id) void unregister(reg.server, reg.id, token, fetcher);
}

/** The root layout: the registration kept up to date with the phone's push token. */
export function useAlertPushUpkeep(): void {
  useEffect(() => {
    if (alertPushSupport() !== 'ok') return;
    void refreshAlertPush();
    return onPushToken((token) => void refreshAlertPush(token));
  }, []);
}

/** Tests. */
export function resetAlertPush(): void {
  current = undefined;
  loaded = undefined;
  emit();
}

/**
 * The web relay's address and token (the token in secure storage; see transport.web.ts). With no
 * address set, the relay on the web app's own origin is used when that origin answers
 * /v1/server-info as one (a container behind a proxy that sends /v1/ to the relay, or a tunnel):
 * "this server's relay". The token is always the user's to give (typed, or from pairing).
 */
import { pageOrigin } from '../settings/runtimeConfig';
import { getJson, setJson } from '../storage/kv';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

export interface RelaySettings {
  /** `wss://relay.example.net` (the `/ssh` path is added). */
  url: string;
  token: string;
  /** The address is this server's relay (none was set): the page's origin answered as a relay. */
  sameOrigin?: boolean;
}

const URL_KEY = 'relay.url';
const TOKEN_KEY = 'relay.token';
const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * The first character of a token that a browser can't send: the token travels as a WebSocket
 * subprotocol (`token.<token>`), which allows only RFC 7230 token characters, so `new WebSocket`
 * throws on base64's `/` and `=`. undefined when every character is fine (hex always is).
 */
export function badTokenCharacter(token: string): string | undefined {
  return [...token].find((ch) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/.test(ch));
}

/**
 * Why this can't be a relay address, or undefined: wss:// or https:// (ws:// and http:// only for
 * this machine), a host, no user name, query or fragment. ws://[::1] is refused (`loopback6`):
 * the web app's content security policy allows ws:// to localhost and 127.0.0.1 only
 * (public/index.html), so the app would take the address and then fail to connect.
 */
export function relayUrlProblem(url: string): 'invalid' | 'insecure' | 'loopback6' | undefined {
  const s = url.trim();
  if (s === '' || /[\s\\]/.test(s) || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) return 'invalid';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'invalid';
  }
  if (!u.hostname || u.username || u.password || u.search || u.hash || s.includes('#') || s.includes('?')) return 'invalid';
  if (u.protocol === 'wss:' || u.protocol === 'https:') return undefined;
  if ((u.protocol === 'ws:' || u.protocol === 'http:') && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return undefined;
  if ((u.protocol === 'ws:' || u.protocol === 'http:') && u.hostname === '[::1]') return 'loopback6';
  return u.protocol === 'ws:' || u.protocol === 'http:' ? 'insecure' : 'invalid';
}

let detected: Promise<string | undefined> | undefined;

/**
 * The relay on the page's own origin, as `wss://host` (`ws://` for an http page), when the origin
 * answers /v1/server-info as md-runbook-relay; undefined otherwise, and on the phones. Asked once
 * per page load. `fetcher`: tests.
 */
export function sameOriginRelay(fetcher?: typeof fetch): Promise<string | undefined> {
  return (detected ??= (async () => {
    const origin = pageOrigin();
    if (!origin) return undefined;
    try {
      const r = await (fetcher ?? fetch)(`${origin}/v1/server-info`, { cache: 'no-store' });
      if (!r.ok) return undefined;
      const info = (await r.json()) as { name?: unknown; protocol?: unknown } | null;
      // The app's own page (a single-page host answers every path with it) is not JSON: no relay.
      if (info?.name !== 'md-runbook-relay' || typeof info.protocol !== 'number') return undefined;
      return origin.replace(/^http(s?):\/\//, 'ws$1://');
    } catch {
      return undefined;
    }
  })());
}

/** The address set by the user ('' when none: then this server's relay, if any, is used). */
export async function getRelayUrlSetting(): Promise<string> {
  return (await getJson(URL_KEY, isString)) ?? '';
}

/** The token as saved ('' when none), whether or not there is an address to use it with. */
export async function getRelayToken(): Promise<string> {
  return (await getSecret(TOKEN_KEY)) ?? '';
}

export async function getRelaySettings(): Promise<RelaySettings | undefined> {
  const [set, token] = await Promise.all([getRelayUrlSetting(), getSecret(TOKEN_KEY)]);
  if (!token) return undefined;
  if (set) return { url: set, token };
  const own = await sameOriginRelay();
  return own ? { url: own, token, sameOrigin: true } : undefined;
}

/**
 * Save the address and token. An empty address keeps "this server's relay" (none set: never
 * stored as an address, so the user's own address is never replaced by it); an empty token
 * removes both.
 */
export async function setRelaySettings(s: RelaySettings | undefined): Promise<void> {
  if (!s || s.token === '') {
    await Promise.all([setJson(URL_KEY, ''), deleteSecret(TOKEN_KEY)]);
    return;
  }
  const own = s.url.trim() === '' ? undefined : await sameOriginRelay();
  const url = own !== undefined && s.url.trim().replace(/\/+$/, '') === own ? '' : s.url.trim();
  await Promise.all([setJson(URL_KEY, url), setSecret(TOKEN_KEY, s.token)]);
}

/** Set the address only (a hosts list that names its relay): the token stays as it is. */
export async function setRelayUrl(url: string): Promise<void> {
  await setJson(URL_KEY, url.trim());
}

/** Tests: ask the page's origin again. */
export function resetSameOriginRelay(): void {
  detected = undefined;
}

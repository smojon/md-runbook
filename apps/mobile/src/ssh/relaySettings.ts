/** The web relay's address and token (the token in secure storage; see transport.web.ts). */
import { getJson, setJson } from '../storage/kv';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

export interface RelaySettings {
  /** `wss://relay.example.net` (the `/ssh` path is added). */
  url: string;
  token: string;
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

export async function getRelaySettings(): Promise<RelaySettings | undefined> {
  const [url, token] = await Promise.all([getJson(URL_KEY, isString), getSecret(TOKEN_KEY)]);
  return url && token ? { url, token } : undefined;
}

export async function setRelaySettings(s: RelaySettings | undefined): Promise<void> {
  if (!s || s.url.trim() === '' || s.token === '') {
    await Promise.all([setJson(URL_KEY, ''), deleteSecret(TOKEN_KEY)]);
    return;
  }
  await Promise.all([setJson(URL_KEY, s.url.trim()), setSecret(TOKEN_KEY, s.token)]);
}

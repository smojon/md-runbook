/**
 * Web: the browser has no keychain, so secrets sit in localStorage of the app's origin: the relay
 * token, the assistant's API key, and an earlier version's app key (new ones are WebCrypto keys
 * the browser won't export, ssh/webKey.ts). Other origins can't read them, but the browser
 * profile holds them in clear, and so can script on the page (the page's CSP, public/index.html).
 */
const prefix = 'mdrb.secure.';

export async function getSecret(key: string): Promise<string | null> {
  try {
    return globalThis.localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  globalThis.localStorage.setItem(prefix + key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  try {
    globalThis.localStorage.removeItem(prefix + key);
  } catch {
    // nothing stored
  }
}

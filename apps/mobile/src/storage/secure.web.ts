/**
 * Web: the browser has no keychain, so secrets sit in localStorage of the app's origin: the relay
 * token, library upload tokens, stored secrets (${secret:NAME}), the assistant's API key, and an
 * earlier version's app key (new ones are WebCrypto keys the browser won't export, ssh/webKey.ts;
 * none is made on a plain-http page, ssh/appKey.ts). Not secret, also here: the key's certificate
 * and the passkey's id. Other origins can't read them, but the browser
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

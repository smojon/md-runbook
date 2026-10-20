/**
 * Web: the browser has no keychain, so the app's key sits in localStorage of the app's origin
 * (a passkey-wrapped key is the planned upgrade). Other origins can't read it, but the browser
 * profile holds it in clear.
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

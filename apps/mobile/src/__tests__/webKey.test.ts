/**
 * The web app's key as a WebCrypto key the browser won't export (ssh/webKey.ts): made with
 * extractable false, kept as a CryptoKey (a Map here, IndexedDB in the browser), signing through
 * crypto.subtle for SSH logins and signatures. A key from an earlier version (PKCS#8 in the
 * browser's storage) stays until the user replaces it. Off a secure page (plain http) no key is made.
 */
import { ExternalAwareEcdsaP256, publicKeyLine, signSshsig } from '@md-runbook/ssh';
import { webcrypto } from 'node:crypto';
import { Platform } from 'react-native';
import type { WebKeyStore } from '../ssh/webKey';

// The module itself (the app key tests below use it through a mock with the store in memory).
const { loadWebKey, makeWebKey, rsToDer } = jest.requireActual<typeof import('../ssh/webKey')>('../ssh/webKey');

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const memory = (): WebKeyStore & { keys: CryptoKeyPair | undefined } => {
  const s = {
    keys: undefined as CryptoKeyPair | undefined,
    get: async () => s.keys,
    put: async (k: CryptoKeyPair) => void (s.keys = k),
    remove: async () => void (s.keys = undefined),
  };
  return s;
};

const mockStore = memory();
/** False: a page without WebCrypto (plain http from a LAN address). */
const mockWebKeys = { available: true };
jest.mock('../ssh/webKey', () => {
  const actual = jest.requireActual<typeof import('../ssh/webKey')>('../ssh/webKey');
  return {
    ...actual,
    webKeysAvailable: () => mockWebKeys.available,
    loadWebKey: () => actual.loadWebKey(mockStore),
    makeWebKey: () => actual.makeWebKey(mockStore),
    removeWebKey: () => actual.removeWebKey(mockStore),
  };
});
const mockSecrets = new Map<string, string>();
jest.mock('../storage/secure', () => ({
  getSecret: async (k: string) => mockSecrets.get(k) ?? null,
  setSecret: async (k: string, v: string) => void mockSecrets.set(k, v),
  deleteSecret: async (k: string) => void mockSecrets.delete(k),
}));
jest.mock('../settings/store', () => {
  const s = { keyNeedsUser: false };
  return { loadSettings: async () => s, outputSettings: () => s, setOutputSetting: (k: 'keyNeedsUser', v: boolean) => (s[k] = v) };
});

type AppKeyModule = typeof import('../ssh/appKey');
const fresh = (): AppKeyModule => {
  let m: AppKeyModule | undefined;
  jest.isolateModules(() => {
    m = jest.requireActual<AppKeyModule>('../ssh/appKey');
  });
  return m!;
};

beforeEach(() => {
  mockStore.keys = undefined;
  mockSecrets.clear();
  mockWebKeys.available = true;
});

describe('a key the browser won’t export (WebCrypto)', () => {
  it('signs SSH logins and runbook signatures; its private key can’t be read out', async () => {
    const store = memory();
    const pair = await makeWebKey(store, subtle);
    expect(store.keys!.privateKey.extractable).toBe(false);
    await expect(subtle.exportKey('pkcs8', store.keys!.privateKey)).rejects.toThrow();
    const alg = new ExternalAwareEcdsaP256();
    const data = Buffer.from('to sign');
    const sig = await alg.createSigner(pair).sign(data);
    expect(await alg.createVerifier(pair).verify(data, sig)).toBe(true);
    // An SSHSIG blob (base64 of "SSHSIG" first).
    expect(await signSshsig(pair, 'manifest')).toMatch(/^U1NIU0lH/);
    // The same key next time.
    const again = await loadWebKey(store, subtle);
    expect(await publicKeyLine(again!, 'x')).toBe(await publicKeyLine(pair, 'x'));
  });

  it('DER from r ‖ s: leading zeros dropped, a high bit gets a 0 byte', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[63] = 1;
    expect([...rsToDer(raw).subarray(0, 6)]).toEqual([0x30, 2 + 33 + 2 + 1, 0x02, 33, 0x00, 0x80]);
    expect([...rsToDer(raw).subarray(-3)]).toEqual([0x02, 1, 1]);
  });
});

describe('the web app’s key', () => {
  beforeAll(() => jest.replaceProperty(Platform, 'OS', 'web'));

  it('is a WebCrypto key from the start, nothing in the browser’s storage', async () => {
    const m = fresh();
    expect((await m.appKeyInfo()).storage).toBe('browser-key');
    expect(mockSecrets.size).toBe(0);
    expect(await fresh().appPublicKeyLine()).toBe(await m.appPublicKeyLine());
  });

  it('an earlier version’s key stays until replaced; Replace makes a new one and drops the old', async () => {
    // As an earlier version made it: PKCS#8 in the browser's storage.
    const { generateKey, privateKeyPem } = jest.requireActual<typeof import('@md-runbook/ssh')>('@md-runbook/ssh');
    mockSecrets.set('app-key.pkcs8', await privateKeyPem(await generateKey()));
    const m = fresh();
    expect((await m.appKeyInfo()).storage).toBe('browser');
    const old = await m.appPublicKeyLine();
    expect((await m.replaceWithUnexportableKey()).storage).toBe('browser-key');
    expect(mockSecrets.has('app-key.pkcs8')).toBe(false);
    expect(await m.appPublicKeyLine()).not.toBe(old);
    expect((await fresh().appKeyInfo()).storage).toBe('browser-key');
  });

  it('off a secure page (plain http): no key at all, nothing readable stored', async () => {
    mockWebKeys.available = false;
    const m = fresh();
    await expect(m.appKeyInfo()).rejects.toBeInstanceOf(m.InsecurePageError);
    await expect(m.appPublicKeyLine()).rejects.toThrow(/open the app over https/);
    expect(mockSecrets.size).toBe(0);
    expect(mockStore.keys).toBeUndefined();
    // Not cached: the same browser on https makes its key.
    mockWebKeys.available = true;
    expect((await m.appKeyInfo()).storage).toBe('browser-key');
  });

  it('off a secure page an earlier version’s key still logs in; after a reset none is made', async () => {
    const { generateKey, privateKeyPem } = jest.requireActual<typeof import('@md-runbook/ssh')>('@md-runbook/ssh');
    const pem = await privateKeyPem(await generateKey());
    mockSecrets.set('app-key.pkcs8', pem);
    mockWebKeys.available = false;
    const m = fresh();
    expect((await m.appKeyInfo()).storage).toBe('browser');
    expect(mockSecrets.get('app-key.pkcs8')).toBe(pem);
    await m.resetAppKey();
    await expect(m.appKeyInfo()).rejects.toBeInstanceOf(m.InsecurePageError);
    expect(mockSecrets.size).toBe(0);
  });

  it('an unreadable earlier key: a WebCrypto key on a secure page, never a new readable one', async () => {
    mockSecrets.set('app-key.pkcs8', 'not a key');
    expect((await fresh().appKeyInfo()).storage).toBe('browser-key');
    expect(mockSecrets.get('app-key.pkcs8')).toBe('not a key');
    mockStore.keys = undefined;
    mockWebKeys.available = false;
    const m = fresh();
    await expect(m.appKeyInfo()).rejects.toBeInstanceOf(m.InsecurePageError);
    expect(mockSecrets.get('app-key.pkcs8')).toBe('not a key');
  });
});

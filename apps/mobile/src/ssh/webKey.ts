/**
 * The web app's SSH key as a WebCrypto key the browser won't export: ECDSA P-256 made with
 * `extractable: false` and kept as a CryptoKey in IndexedDB (stored keys keep that flag). Script on
 * the page can ask it to sign while the page is open, but can't read the private key out: no copy
 * of it leaves this browser profile.
 *
 * The SSH library sees an ExternalKeyPair, as for the phones' hardware keys (appKey.ts).
 */
import { ExternalKeyPair } from '@md-runbook/ssh';
import { Platform } from 'react-native';

/** Where the key pair is kept (IndexedDB in the browser; a Map in tests). */
export interface WebKeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  put(keys: CryptoKeyPair): Promise<void>;
  remove(): Promise<void>;
}

const DB = 'mdrb-keys';
const STORE = 'keys';
const ID = 'app-key';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB refused'));
  });
}

async function inStore<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
    });
  } finally {
    db.close();
  }
}

export const indexedDbKeyStore: WebKeyStore = {
  get: async () => ((await inStore('readonly', (s) => s.get(ID))) as CryptoKeyPair | undefined) ?? undefined,
  put: async (keys) => void (await inStore('readwrite', (s) => s.put(keys, ID))),
  remove: async () => void (await inStore('readwrite', (s) => s.delete(ID))),
};

/** The web app on a secure page with WebCrypto and IndexedDB. */
export function webKeysAvailable(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof indexedDB !== 'undefined' &&
    globalThis.crypto?.subtle !== undefined &&
    (globalThis as { isSecureContext?: boolean }).isSecureContext !== false
  );
}

/** WebCrypto's ECDSA signature (r ‖ s, 32 bytes each) as DER `SEQUENCE { INTEGER r, INTEGER s }`. */
export function rsToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error('expected a 64-byte P-256 signature');
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.subarray(i)];
    return v[0]! & 0x80 ? [0, ...v] : v;
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function asPair(keys: CryptoKeyPair, subtle: SubtleCrypto): Promise<ExternalKeyPair> {
  // The public half is always exportable: 0x04 ‖ X ‖ Y.
  const publicKey = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  return ExternalKeyPair.create({
    publicKey,
    sign: async (data) =>
      rsToDer(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new Uint8Array(data)))),
  });
}

/** The key made before in this browser, or undefined. */
export async function loadWebKey(
  store: WebKeyStore = indexedDbKeyStore,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<ExternalKeyPair | undefined> {
  const keys = await store.get();
  return keys ? asPair(keys, subtle) : undefined;
}

/** A new key the browser won't export, kept in place of any earlier one. */
export async function makeWebKey(
  store: WebKeyStore = indexedDbKeyStore,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<ExternalKeyPair> {
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await store.put(keys);
  return asPair(keys, subtle);
}

export async function removeWebKey(store: WebKeyStore = indexedDbKeyStore): Promise<void> {
  await store.remove();
}

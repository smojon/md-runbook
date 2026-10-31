/**
 * The web app's "Use a passkey": the switch makes a passkey (the browser's WebAuthn, stubbed here
 * with an authenticator in Node), the key line becomes a verify-required sk-ecdsa one, logins and
 * signatures go through navigator.credentials.get, and off makes a library key again. OpenSSH's own
 * check of these signatures is in the repository's test/sshPasskey.test.ts and ssh.live.test.ts.
 */
import { WEBAUTHN_SK_ECDSA_P256, base64url } from '@md-runbook/ssh';
import { type KeyObject, createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { Platform } from 'react-native';

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

const RP = 'runbook.example.net';
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
/** A copy in an ArrayBuffer of its own (a Buffer may be a view into a shared pool). */
const ab = (b: Uint8Array): ArrayBuffer => new Uint8Array(b).buffer;

/** A platform authenticator: one ES256 key per create, user present and verified. */
const authenticator = {
  keys: new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>(),
  created: 0,
  gets: [] as { userVerification?: string; rpId?: string; id: string }[],
  refuseNext: false,
  async create(o: { publicKey: PublicKeyCredentialCreationOptions }) {
    if (authenticator.refuseNext) {
      authenticator.refuseNext = false;
      throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
    }
    expect(o.publicKey.rp.id).toBe(RP);
    expect(o.publicKey.authenticatorSelection?.userVerification).toBe('required');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const id = Buffer.from(`cred-${++authenticator.created}`);
    authenticator.keys.set(id.toString('base64url'), pair);
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
    return { rawId: ab(id), response: { getPublicKeyAlgorithm: () => -7, getPublicKey: () => ab(spki) } };
  },
  async get(o: { publicKey: PublicKeyCredentialRequestOptions }) {
    const id = Buffer.from(o.publicKey.allowCredentials![0]!.id as Uint8Array).toString('base64url');
    authenticator.gets.push({ userVerification: o.publicKey.userVerification, rpId: o.publicKey.rpId, id });
    const challenge = new Uint8Array(o.publicKey.challenge as Uint8Array);
    const authenticatorData = Buffer.concat([sha256(o.publicKey.rpId!), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: base64url(challenge), origin: `https://${RP}` }));
    const signature = nodeSign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      authenticator.keys.get(id)!.privateKey,
    );
    return { response: { authenticatorData: ab(authenticatorData), clientDataJSON: ab(clientDataJSON), signature: ab(signature) } };
  },
};

beforeAll(() => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const w = globalThis as unknown as Record<string, unknown>;
  w.window = w;
  w.isSecureContext = true;
  w.PublicKeyCredential = class {};
  w.location = { hostname: RP };
  Object.defineProperty(globalThis, 'navigator', { value: { credentials: authenticator }, configurable: true });
});

describe('the web app with "Use a passkey"', () => {
  it('makes a passkey, logs in and signs with it, and goes back to a library key when off', async () => {
    const { appKeyInfo, appPublicKeyLine, setKeyNeedsUser } = jest.requireActual<typeof import('../ssh/appKey')>('../ssh/appKey');
    // Off (the default): a key made by the SSH library, kept in the browser's storage.
    expect((await appKeyInfo()).storage).toBe('browser');
    const before = await appPublicKeyLine();
    expect(before).toMatch(/^ecdsa-sha2-nistp256 /);

    // A cancelled or refused prompt leaves the key as it was.
    authenticator.refuseNext = true;
    await expect(setKeyNeedsUser(true)).rejects.toThrow(/not allowed/);
    expect(await appPublicKeyLine()).toBe(before);
    expect(mockSecrets.has('app-key.pkcs8')).toBe(true);

    const k = await setKeyNeedsUser(true);
    expect(k.storage).toBe('passkey');
    expect(mockSecrets.has('app-key.pkcs8')).toBe(false);
    const line = await appPublicKeyLine();
    expect(line).toMatch(/^verify-required sk-ecdsa-sha2-nistp256@openssh\.com AAAA\S+ md-runbook-app$/);
    // Only public parts are kept.
    expect(Object.keys(JSON.parse(mockSecrets.get('app-key.passkey')!)).sort()).toEqual(['id', 'publicKey', 'rpId']);

    // What an SSH login signs goes to the authenticator, which must verify the person.
    const blob = await (k.pair as import('@md-runbook/ssh').PasskeyKeyPair).signBlob(new Uint8Array([1, 2, 3]));
    expect(blob.subarray(4, 4 + WEBAUTHN_SK_ECDSA_P256.length).toString()).toBe(WEBAUTHN_SK_ECDSA_P256);
    expect(authenticator.gets.at(-1)).toEqual({ userVerification: 'required', rpId: RP, id: Buffer.from('cred-1').toString('base64url') });

    // Off again: the passkey is forgotten here, a new library key is made.
    expect((await setKeyNeedsUser(false)).storage).toBe('browser');
    expect(mockSecrets.has('app-key.passkey')).toBe(false);
    expect(await appPublicKeyLine()).toMatch(/^ecdsa-sha2-nistp256 /);
  });

  it('a passkey made for another host name is not offered: the switch asks for a new one', async () => {
    const m = jest.requireActual<typeof import('../ssh/passkey')>('../ssh/passkey');
    await m.createPasskey();
    expect(await m.loadPasskey()).toBeDefined();
    (globalThis as unknown as { location: { hostname: string } }).location.hostname = 'other.example.net';
    try {
      expect(await m.loadPasskey()).toBeUndefined();
    } finally {
      (globalThis as unknown as { location: { hostname: string } }).location.hostname = RP;
    }
  });
});

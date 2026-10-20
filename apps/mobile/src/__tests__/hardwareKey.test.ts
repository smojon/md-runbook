import type { KeyObject } from 'node:crypto';
import { hostKeyId } from '@md-runbook/ssh';

/** The native module, played by Node's crypto: one key per alias, signatures in DER. */
const mockKeys = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>();
const mockHardware = {
  available: true,
  failGenerate: false,
  signed: 0,
};
jest.mock('../../modules/hardware-key', () => {
  const c = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const point = (alias: string): string => {
    const jwk = mockKeys.get(alias)!.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  };
  return {
    get HardwareKey() {
      if (!mockHardware.available) return null;
      return {
        publicKey: async (alias: string) => (mockKeys.has(alias) ? point(alias) : null),
        generate: async (alias: string) => {
          if (mockHardware.failGenerate) throw new Error('keystore unavailable');
          mockKeys.set(alias, c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
          return { publicKey: point(alias), hardware: true };
        },
        sign: async (alias: string, data: string) => {
          mockHardware.signed++;
          return c.sign('sha256', Buffer.from(data, 'base64'), mockKeys.get(alias)!.privateKey).toString('base64');
        },
        remove: async (alias: string) => void mockKeys.delete(alias),
        isHardware: async (alias: string) => mockKeys.has(alias),
      };
    },
  };
});

const mockSecrets = new Map<string, string>();
jest.mock('../storage/secure', () => ({
  getSecret: async (k: string) => mockSecrets.get(k) ?? null,
  setSecret: async (k: string, v: string) => void mockSecrets.set(k, v),
  deleteSecret: async (k: string) => void mockSecrets.delete(k),
}));

type AppKeyModule = typeof import('../ssh/appKey');
type SshModule = typeof import('@md-runbook/ssh');
/** A fresh app key module (an app start), with the SSH package of the same module registry. */
const fresh = (): AppKeyModule & { ssh: SshModule } => {
  let m: (AppKeyModule & { ssh: SshModule }) | undefined;
  jest.isolateModules(() => {
    m = { ...jest.requireActual<AppKeyModule>('../ssh/appKey'), ssh: jest.requireActual<SshModule>('@md-runbook/ssh') };
  });
  return m!;
};

beforeEach(() => {
  mockKeys.clear();
  mockSecrets.clear();
  Object.assign(mockHardware, { available: true, failGenerate: false, signed: 0 });
});

describe("the app's key in the phone's hardware", () => {
  it('is made by the hardware, kept there, and signs there', async () => {
    const m = fresh();
    const info = await m.appKeyInfo();
    expect(info.storage).toBe('hardware');
    expect(mockSecrets.size).toBe(0);
    const line = await m.appPublicKeyLine();
    expect(line).toMatch(/^ecdsa-sha2-nistp256 AAAA\S+ md-runbook-app$/);

    // The SSH layer signs through the hardware; the signature checks against the hardware's key.
    const alg = new m.ssh.ExternalAwareEcdsaP256();
    const data = Buffer.from('to sign');
    const sig = await alg.createSigner(info.pair).sign(data);
    expect(mockHardware.signed).toBe(1);
    expect(await alg.createVerifier(info.pair).verify(data, sig)).toBe(true);

    // Next start: the same key.
    expect(hostKeyId(await fresh().appPublicKeyLine())).toBe(hostKeyId(line));
    await m.resetAppKey();
    expect(mockKeys.size).toBe(0);
  });

  it('keeps the key of an earlier version: hosts already trust it', async () => {
    mockHardware.available = false;
    const old = await fresh().appPublicKeyLine();
    mockHardware.available = true;
    const m = fresh();
    expect((await m.appKeyInfo()).storage).toBe('secure-store');
    expect(hostKeyId(await m.appPublicKeyLine())).toBe(hostKeyId(old));
    expect(mockKeys.size).toBe(0);
  });

  it('falls back to secure storage when the hardware refuses', async () => {
    mockHardware.failGenerate = true;
    const m = fresh();
    expect((await m.appKeyInfo()).storage).toBe('secure-store');
    expect(mockSecrets.get('app-key.pkcs8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });
});

import { hostKeyId } from '@md-runbook/ssh';
import { fingerprint } from '../ssh/fingerprint';

const mockSecrets = new Map<string, string>();
jest.mock('../storage/secure', () => ({
  getSecret: async (k: string) => mockSecrets.get(k) ?? null,
  setSecret: async (k: string, v: string) => void mockSecrets.set(k, v),
  deleteSecret: async (k: string) => void mockSecrets.delete(k),
}));

describe("the app's key", () => {
  it('is made once, kept in secure storage and read back', async () => {
    type AppKeyModule = typeof import('../ssh/appKey');
    const fresh = (): AppKeyModule => {
      let m: AppKeyModule | undefined;
      jest.isolateModules(() => {
        m = jest.requireActual<AppKeyModule>('../ssh/appKey');
      });
      return m!;
    };
    const { appKey, appPublicKeyLine, resetAppKey } = fresh();
    const line = await appPublicKeyLine();
    expect(line).toMatch(/^ecdsa-sha2-nistp256 AAAA\S+ md-runbook-app$/);
    expect(mockSecrets.get('app-key.pkcs8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(await appKey()).toBe(await appKey());

    // A fresh module (app restart) imports the stored key: same public key.
    const again = fresh();
    expect(hostKeyId(await again.appPublicKeyLine())).toBe(hostKeyId(line));

    await again.resetAppKey();
    expect(mockSecrets.has('app-key.pkcs8')).toBe(false);
    expect(hostKeyId(await again.appPublicKeyLine())).not.toBe(hostKeyId(line));
    await resetAppKey();
  });

  it('fingerprints a host key the OpenSSH way', async () => {
    // ssh-keygen -lf of this key: SHA256:cFhm7kqMhMFfl3xbDXdCg3kx/Zj4npMgKlJfLj/nAas
    const key =
      'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGe+ETSSEqfHjc1rfcKRwiVWwN+Nqk1V6oxk6ncqNZAlmVWJmcx8yz8+pkKv7dV0lbsEzdW4U2/pF5yU6Jc8OmY= test';
    const fp = await fingerprint(key);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(await fingerprint(key)).toBe(fp);
  });
});

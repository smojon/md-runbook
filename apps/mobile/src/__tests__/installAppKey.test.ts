/** Install My Key: the host key check comes first; the password goes only to a trusted server. */
const mockServer = { hostKey: 'ecdsa-sha2-nistp256 AAAAserver= host', passwords: [] as string[] };
jest.mock('@md-runbook/ssh', () => ({
  ...jest.requireActual('@md-runbook/ssh'),
  installPublicKey: async (
    _stream: unknown,
    o: { password: string; keyLine: string; verifyHostKey(l: string): boolean | Promise<boolean> },
  ) => {
    if (!(await o.verifyHostKey(mockServer.hostKey))) throw new Error('host key refused');
    mockServer.passwords.push(o.password);
    return 'added';
  },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(async () => ({})), transportReady: async () => undefined }));
jest.mock('../ssh/appKey', () => ({ appPublicKeyLine: async () => 'ecdsa-sha2-nistp256 AAAAapp= md-runbook-app' }));

import { hostKeyId } from '@md-runbook/ssh';
import { installAppKey } from '../ssh/installAppKey';

const host = { id: 'h1', name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' };

beforeEach(() => (mockServer.passwords = []));

it('an unknown host key comes back to trust, and the password is not sent', async () => {
  expect(await installAppKey(host, 'secret')).toEqual({ kind: 'trust', hostKey: mockServer.hostKey, changed: false });
  expect(mockServer.passwords).toEqual([]);
});

it('a trusted host gets the key; a changed key is reported as changed', async () => {
  expect(await installAppKey({ ...host, hostKey: hostKeyId(mockServer.hostKey) }, 'secret')).toEqual({ kind: 'added' });
  expect(mockServer.passwords).toEqual(['secret']);
  expect(await installAppKey({ ...host, hostKey: 'ecdsa-sha2-nistp256 AAAAold=' }, 'secret')).toEqual({
    kind: 'trust',
    hostKey: mockServer.hostKey,
    changed: true,
  });
});

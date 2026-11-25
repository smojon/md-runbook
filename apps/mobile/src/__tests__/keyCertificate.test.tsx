/**
 * A certificate on the app's key (ssh/appCert.ts, screens/KeyCertificate.tsx): attached by paste,
 * checked against the key, sent first at login, dropped with the key, warned about before and
 * after expiry. Parsing and OpenSSH's own check are in the repository's test/sshCert.test.ts and
 * test/ssh.live.test.ts.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CertKeyPair, generateKey } from '@md-runbook/ssh';
import { randomBytes } from 'node:crypto';
import { Alert } from 'react-native';
import { appKey, appKeyInfo, resetAppKey } from '../ssh/appKey';
import {
  CertificateError,
  appCert,
  attachAppCert,
  loadAppCert,
  loginKeys,
  removeAppCert,
  resetAppCertCache,
  timeLeft,
} from '../ssh/appCert';
import { CertificateNotice, KeyCertificateSection, certWarning } from '../screens/KeyCertificate';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u64 = (n: number): Buffer =>
  n === Infinity ? Buffer.alloc(8, 0xff) : Buffer.concat([u32(Math.floor(n / 0x100000000)), u32(n % 0x100000000)]);
const str = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
  return Buffer.concat([u32(v.length), v]);
};

/** A user certificate line for a plain public key blob, in OpenSSH's format (the CA signature is random: clients don't check it). */
function certLine(
  publicKey: Uint8Array,
  o: { keyId?: string; principals?: string[]; validAfter?: number; validBefore?: number } = {},
): string {
  const pk = Buffer.from(publicKey);
  const n = pk.readUInt32BE(0);
  const type = `${pk.subarray(4, 4 + n).toString('ascii')}-cert-v01@openssh.com`;
  const blob = Buffer.concat([
    str(type),
    str(randomBytes(32)),
    pk.subarray(4 + n),
    u64(5),
    u32(1),
    str(o.keyId ?? 'alice@corp'),
    str(Buffer.concat((o.principals ?? ['alice']).map((p) => str(p)))),
    u64(o.validAfter ?? 0),
    u64(o.validBefore ?? Infinity),
    str(''),
    str(''),
    str(''),
    str(Buffer.concat([str('ssh-ed25519'), str(randomBytes(32))])),
    str(Buffer.concat([str('ssh-ed25519'), str(randomBytes(64))])),
  ]);
  return `${type} ${blob.toString('base64')} issued`;
}

const ownBlob = async (): Promise<Buffer> => (await (await appKey()).getPublicKeyBytes())!;
const now = (): number => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await removeAppCert();
  resetAppCertCache();
  mockPush.mockClear();
});

describe('certificate on the app key', () => {
  it('attaches a certificate for the key; logins send it first, then the key alone', async () => {
    const key = await appKeyInfo();
    const cert = await attachAppCert(`\n${certLine(await ownBlob())}\n`, key);
    expect(cert.keyId).toBe('alice@corp');
    const keys = await loginKeys(key.pair);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeInstanceOf(CertKeyPair);
    expect(keys[0]!.keyAlgorithmName).toBe('ecdsa-sha2-nistp256-cert-v01@openssh.com');
    expect(keys[1]).toBe(key.pair);
    // After a restart it is read back from secure storage.
    resetAppCertCache();
    await loadAppCert();
    expect(appCert()?.keyId).toBe('alice@corp');
  });

  it('refuses a certificate for another key, a plain key and a passkey; nothing is kept', async () => {
    const key = await appKeyInfo();
    const other = (await (await generateKey()).getPublicKeyBytes())!;
    await expect(attachAppCert(certLine(other), key)).rejects.toMatchObject({ reason: 'other-key' });
    const plain = `ecdsa-sha2-nistp256 ${(await ownBlob()).toString('base64')} me`;
    await expect(attachAppCert(plain, key)).rejects.toMatchObject({ reason: 'unreadable' });
    await expect(attachAppCert(certLine(await ownBlob()), { ...key, storage: 'passkey' })).rejects.toBeInstanceOf(CertificateError);
    expect(appCert()).toBeUndefined();
    expect(await loginKeys(key.pair)).toEqual([key.pair]);
  });

  it('a new key drops the certificate (it was for the old one)', async () => {
    await attachAppCert(certLine(await ownBlob()), await appKeyInfo());
    await resetAppKey();
    expect(appCert()).toBeUndefined();
    resetAppCertCache();
    await loadAppCert();
    expect(appCert()).toBeUndefined();
  });

  it('warns in the last quarter of its life (at most a day ahead) and after it expired', async () => {
    const t0 = 1_800_000_000;
    const cert = await attachAppCert(certLine(await ownBlob(), { validAfter: t0, validBefore: t0 + 8 * 3600 }), await appKeyInfo());
    expect(certWarning(cert, (t0 + 3600) * 1000)).toBeUndefined();
    expect(certWarning(cert, (t0 + 6 * 3600) * 1000)).toBe('Expires in 2 hours. Get a new one from your CA.');
    expect(certWarning(cert, (t0 + 9 * 3600) * 1000)).toMatch(/^Expired \d{4}-\d\d-\d\d \d\d:\d\d\. Hosts that need it refuse the login/);
    expect(certWarning(cert, (t0 - 60) * 1000)).toMatch(/^Valid from /);
    expect(timeLeft(t0 + 3 * 86400 + 10, t0 * 1000)).toEqual({ n: 3, unit: 'day' });
    expect(timeLeft(t0 + 30, t0 * 1000)).toEqual({ n: 1, unit: 'minute' });
  });
});

describe('Hosts & settings → Certificate', () => {
  it('paste: shows key ID, users, expiry and CA; a wrong one says why; Remove asks first', async () => {
    await render(<KeyCertificateSection storage="secure-store" />);
    expect(screen.getByText(/For hosts that trust your company’s SSH certificate authority/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('key-cert-paste'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('key-cert-input'), `ecdsa-sha2-nistp256 ${(await ownBlob()).toString('base64')} me`);
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('key-cert-attach'));
    });
    expect(screen.getByTestId('key-cert-message').props.children).toMatch(/^Not a user certificate: not a certificate but a plain key/);

    const line = certLine(await ownBlob(), {
      keyId: 'alice@corp',
      principals: ['alice', 'deploy'],
      validAfter: now() - 7 * 3600,
      validBefore: now() + 2 * 3600 + 120,
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('key-cert-input'), line);
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('key-cert-attach'));
    });
    await waitFor(() => expect(screen.getByText('Key ID: alice@corp')).toBeTruthy());
    expect(screen.getByText('Users: alice, deploy')).toBeTruthy();
    expect(screen.getByTestId('key-cert-validity').props.children).toMatch(/^Valid until .+ \(in 2 hours\)$/);
    expect(screen.getByText(/^CA: SHA256:/)).toBeTruthy();
    expect(screen.getByTestId('key-cert-message').props.children).toBe('Certificate attached: logins send it first.');
    // 2 hours left of 9: in its last quarter.
    expect(screen.getByTestId('key-cert-warning').props.children).toBe('Expires in 2 hours. Get a new one from your CA.');

    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _body, buttons) => buttons?.find((b) => b.style === 'destructive')?.onPress?.());
    await act(async () => {
      fireEvent.press(screen.getByTestId('key-cert-remove'));
    });
    expect(alert).toHaveBeenCalledWith('Remove the certificate?', expect.stringContaining('The key itself stays.'), expect.anything());
    alert.mockRestore();
    await waitFor(() => expect(screen.queryByTestId('key-cert-details')).toBeNull());
    expect(appCert()).toBeUndefined();
  });

  it('a passkey: says certificates need the app’s own key, nothing to attach', async () => {
    await render(<KeyCertificateSection storage="passkey" />);
    expect(screen.getByText('Certificates work with the app’s own key, not with a passkey.')).toBeTruthy();
    expect(screen.queryByTestId('key-cert-paste')).toBeNull();
  });

  it('the start screen warns about an expired certificate; a tap opens Hosts & settings', async () => {
    await render(<CertificateNotice />);
    expect(screen.queryByTestId('cert-notice')).toBeNull();
    await act(async () => {
      await attachAppCert(certLine(await ownBlob(), { validAfter: 0, validBefore: now() - 60 }), await appKeyInfo());
    });
    expect(screen.getByText('Your SSH certificate expired. Tap to replace it.')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cert-notice'));
    });
    expect(mockPush).toHaveBeenCalledWith('/hosts');
  });
});

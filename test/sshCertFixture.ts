/**
 * Test certificates in OpenSSH's format (draft-miller-ssh-cert §2.1) for keys made at run time,
 * where ssh-keygen isn't at hand. The CA signature is random bytes: clients only read
 * certificates, sshd checks them (the live test signs real ones with ssh-keygen).
 */
import { randomBytes } from 'node:crypto';
import { Buffer } from 'buffer';

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u64 = (n: number): Buffer => (n === Infinity ? Buffer.alloc(8, 0xff) : Buffer.concat([u32(Math.floor(n / 0x100000000)), u32(n % 0x100000000)]));
const str = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
  return Buffer.concat([u32(v.length), v]);
};

export interface TestCertOptions {
  keyId?: string;
  principals?: string[];
  /** Seconds since 1970. */
  validAfter?: number;
  validBefore?: number;
  serial?: number;
  /** 1 user, 2 host. */
  certType?: number;
}

/** A certificate for the plain public key blob `publicKey` (`string type, key fields…`). */
export function testCertificate(publicKey: Uint8Array, o: TestCertOptions = {}): Buffer {
  const pk = Buffer.from(publicKey);
  const typeLen = pk.readUInt32BE(0);
  const plain = pk.subarray(4, 4 + typeLen).toString('ascii');
  const fields = pk.subarray(4 + typeLen);
  const type = `${plain}-cert-v01@openssh.com`;
  const ca = Buffer.concat([str('ssh-ed25519'), str(randomBytes(32))]);
  return Buffer.concat([
    str(type),
    str(randomBytes(32)),
    fields,
    u64(o.serial ?? 7),
    u32(o.certType ?? 1),
    str(o.keyId ?? 'test-cert'),
    str(Buffer.concat((o.principals ?? ['alice']).map((p) => str(p)))),
    u64(o.validAfter ?? 0),
    u64(o.validBefore ?? Infinity),
    str(''),
    str(Buffer.concat([str('permit-pty'), str('')])),
    str(''),
    str(ca),
    str(Buffer.concat([str('ssh-ed25519'), str(randomBytes(64))])),
  ]);
}

/** The certificate as a `…-cert.pub` line. */
export function testCertificateLine(publicKey: Uint8Array, o: TestCertOptions = {}): string {
  const blob = testCertificate(publicKey, o);
  const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii');
  return `${type} ${blob.toString('base64')} test`;
}

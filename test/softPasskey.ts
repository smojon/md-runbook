/**
 * A passkey made in Node that answers as a browser's `navigator.credentials.get` does: the
 * authenticator data (relying-party hash, flags, counter), the client data JSON in the browsers'
 * order, an ECDSA signature over both. For tests against OpenSSH, which checks the real thing.
 */
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { type Passkey, base64url } from '@md-runbook/ssh';

export interface SoftPasskeyOptions {
  /** Authenticator flags: 0x05 is user present + user verified (Windows Hello, Touch ID). */
  flags?: number;
  /** Sign for this relying party instead of the passkey's own. */
  signedRpId?: string;
  origin?: string;
  /** The client data as a browser that orders it otherwise would write it. */
  reordered?: boolean;
}

const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();

export function softPasskey(rpId: string, o: SoftPasskeyOptions = {}): Passkey & { signed: number } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  let counter = 0;
  const key = {
    publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])),
    rpId,
    signed: 0,
    async sign(challenge: Uint8Array) {
      key.signed++;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authenticatorData = Buffer.concat([sha256(o.signedRpId ?? rpId), Buffer.from([o.flags ?? 0x05]), count]);
      const origin = o.origin ?? `https://${rpId}`;
      const data = o.reordered
        ? { challenge: base64url(challenge), type: 'webauthn.get', origin, crossOrigin: false }
        : { type: 'webauthn.get', challenge: base64url(challenge), origin, crossOrigin: false };
      const clientDataJSON = Buffer.from(JSON.stringify(data), 'utf8');
      const signature = nodeSign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey);
      return { authenticatorData: new Uint8Array(authenticatorData), clientDataJSON: new Uint8Array(clientDataJSON), signature: new Uint8Array(signature) };
    },
  };
  return key;
}

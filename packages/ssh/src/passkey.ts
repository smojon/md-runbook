/**
 * A passkey (WebAuthn) as the app's SSH key, for the web app, which has no keystore of its own:
 * the private key stays in the authenticator (Windows Hello, iCloud Keychain, a security key) and
 * each login asks the person for it. Stock OpenSSH accepts this: the key is an
 * `sk-ecdsa-sha2-nistp256@openssh.com` key whose application is the passkey's relying party (the
 * web app's host name), and the signature is a `webauthn-sk-ecdsa-sha2-nistp256@openssh.com` one
 * (PROTOCOL.u2f): the browser signs what SSH signs as the WebAuthn challenge.
 *
 * sshd checks it as it checks a security key's: the authenticator data's relying-party hash
 * against the key's application, `verify-required` in authorized_keys against the UV flag, and
 * that the client data begins with the type, the challenge and the origin in that order (it
 * ignores the rest). Logins and SSHSIG signatures (ssh-keygen -Y verify) both work.
 */
import type { ECParameters, KeyPair } from '@microsoft/dev-tunnels-ssh';
import { PublicKeyAlgorithm, Signer, Verifier } from '@microsoft/dev-tunnels-ssh';
import { sha256Bytes } from '@md-runbook/core/sha256';
import { Buffer } from 'buffer';
import { derToRs } from './externalKey';

export const SK_ECDSA_P256 = 'sk-ecdsa-sha2-nistp256@openssh.com';
export const WEBAUTHN_SK_ECDSA_P256 = 'webauthn-sk-ecdsa-sha2-nistp256@openssh.com';

/** What `navigator.credentials.get` returns, as bytes. */
export interface PasskeyAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** DER-encoded ECDSA signature over authenticatorData ‖ SHA-256(clientDataJSON). */
  signature: Uint8Array;
}

export interface Passkey {
  /** The public point, uncompressed: 0x04 ‖ X (32 bytes) ‖ Y (32 bytes). */
  publicKey: Uint8Array;
  /** The relying party the passkey belongs to (the web app's host name): the SSH key's application. */
  rpId: string;
  /** `navigator.credentials.get` with `challenge`, for this passkey. */
  sign(challenge: Uint8Array): Promise<PasskeyAssertion>;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const str = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
  return Buffer.concat([u32(v.length), v]);
};
const mpint = (b: Uint8Array): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = Buffer.from(b.subarray(i));
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return str(v);
};
/** base64url without padding, as WebAuthn writes the challenge (the `buffer` package has no 'base64url'). */
export const base64url = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The public key blob: type, curve, point, application. */
export function skEcdsaPublicKey(point: Uint8Array, application: string): Buffer {
  return Buffer.concat([str(SK_ECDSA_P256), str('nistp256'), str(point), str(application)]);
}

const FLAG_ATTESTED = 0x40;
const FLAG_EXTENSIONS = 0x80;

/**
 * The SSH signature blob for `challenge` from the passkey's assertion. Checks what sshd would
 * refuse without saying why: another relying party, attested credential data, client data not in
 * the order sshd compares.
 */
export function webauthnSignature(rpId: string, challenge: Uint8Array, a: PasskeyAssertion): Buffer {
  const auth = Buffer.from(a.authenticatorData);
  if (auth.length < 37) throw new Error('the passkey returned no authenticator data');
  if (!auth.subarray(0, 32).equals(Buffer.from(sha256Bytes(new TextEncoder().encode(rpId))))) {
    throw new Error(`the passkey signed for another site than ${rpId}`);
  }
  const flags = auth[32]!;
  const extensions = auth.subarray(37);
  if (flags & FLAG_ATTESTED || Boolean(flags & FLAG_EXTENSIONS) !== extensions.length > 0) {
    throw new Error('the passkey returned authenticator data OpenSSH does not accept');
  }
  const clientData = Buffer.from(a.clientDataJSON);
  let origin: unknown;
  try {
    origin = (JSON.parse(clientData.toString('utf8')) as { origin?: unknown }).origin;
  } catch {
    throw new Error('the browser returned client data that is not JSON');
  }
  if (typeof origin !== 'string' || origin.includes('"')) throw new Error('the browser returned no usable origin');
  const preamble = `{"type":"webauthn.get","challenge":"${base64url(challenge)}","origin":"${origin}"`;
  if (!clientData.subarray(0, Buffer.byteLength(preamble)).equals(Buffer.from(preamble, 'utf8'))) {
    throw new Error('the browser wrote its client data in an order OpenSSH does not accept');
  }
  const [r, s] = derToRs(a.signature);
  return Buffer.concat([
    str(WEBAUTHN_SK_ECDSA_P256),
    str(Buffer.concat([mpint(r), mpint(s)])),
    Buffer.from([flags]),
    auth.subarray(33, 37),
    str(origin),
    str(clientData),
    str(extensions),
  ]);
}

/** A passkey as a key pair the SSH library can log in with (and signSshsig can sign with). */
export class PasskeyKeyPair implements KeyPair {
  comment: string | null = null;
  private readonly blob: Buffer;

  constructor(readonly passkey: Passkey) {
    const p = passkey.publicKey;
    if (p.length !== 65 || p[0] !== 4) throw new Error('expected an uncompressed P-256 public key (65 bytes starting with 0x04)');
    if (!passkey.rpId || /\s/.test(passkey.rpId)) throw new Error(`not a relying party: ${passkey.rpId}`);
    this.blob = skEcdsaPublicKey(p, passkey.rpId);
  }

  /** The complete SSH signature blob of `data`, signed by the passkey. */
  async signBlob(data: Uint8Array): Promise<Buffer> {
    const challenge = new Uint8Array(data);
    return webauthnSignature(this.passkey.rpId, challenge, await this.passkey.sign(challenge));
  }

  get keyAlgorithmName(): string {
    return SK_ECDSA_P256;
  }
  get hasPublicKey(): boolean {
    return true;
  }
  get hasPrivateKey(): boolean {
    return true;
  }
  getPublicKeyBytes(): Promise<Buffer | null> {
    return Promise.resolve(Buffer.from(this.blob));
  }
  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(new Error('a passkey cannot be changed'));
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('a passkey is made by its authenticator'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('a passkey cannot be changed'));
  }
  exportParameters(): Promise<ECParameters> {
    return Promise.reject(new Error('a passkey cannot be exported'));
  }
  dispose(): void {}
}

class PasskeySigner implements Signer {
  /** Room for the whole blob; the client data dominates and the writer grows anyway. */
  readonly digestLength = 1024;
  constructor(private readonly key: PasskeyKeyPair) {}
  sign(data: Buffer): Promise<Buffer> {
    return this.key.signBlob(data);
  }
  dispose(): void {}
}

/**
 * `sk-ecdsa-sha2-nistp256@openssh.com` for passkeys, client side only. The library offers every
 * configured algorithm as a host key type too; no server has such a host key, so it never matches.
 */
export class PasskeySkEcdsaP256 extends PublicKeyAlgorithm {
  constructor() {
    super(SK_ECDSA_P256, SK_ECDSA_P256, 'SHA2-256');
  }
  createKeyPair(): KeyPair {
    throw new Error('passkeys are made by the browser');
  }
  generateKeyPair(): Promise<KeyPair> {
    return Promise.reject(new Error('passkeys are made by the browser'));
  }
  createSigner(keyPair: KeyPair): Signer {
    if (!(keyPair instanceof PasskeyKeyPair)) throw new Error(`${SK_ECDSA_P256} signs with passkeys only`);
    return new PasskeySigner(keyPair);
  }
  createVerifier(): Verifier {
    throw new Error(`${SK_ECDSA_P256} is not verified on the client`);
  }
  /** The signer already wrote the whole blob: its type is webauthn-sk-…, not the key's. */
  createSignatureData(signature: Buffer): Buffer {
    return signature;
  }
}

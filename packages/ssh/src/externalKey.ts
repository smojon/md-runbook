/**
 * Client keys whose private half lives elsewhere and never reaches JavaScript: the phone's
 * Secure Enclave or Android Keystore. The caller brings the public point and a `sign` function;
 * the SSH library sees an ordinary ECDSA P-256 key pair, and its signer calls `sign`.
 */
import { Buffer } from 'buffer';
import {
  BigInt as SshBigInt,
  ECParameters,
  KeyPair,
  PublicKeyAlgorithm,
  Signer,
  SshAlgorithms,
  SshDataWriter,
  Verifier,
} from '@microsoft/dev-tunnels-ssh';

export const ECDSA_P256 = 'ecdsa-sha2-nistp256';

export interface ExternalP256Key {
  /** The public point, uncompressed: 0x04 ‖ X (32 bytes) ‖ Y (32 bytes). */
  publicKey: Uint8Array;
  /** ECDSA with SHA-256 over `data`; the signature DER-encoded (what Keystore and the Secure Enclave return). */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

function base(): PublicKeyAlgorithm {
  const alg = SshAlgorithms.publicKey.ecdsaSha2Nistp256;
  if (!alg) throw new Error('ECDSA P-256 is not available on this platform');
  return alg;
}

/** A key pair the library can authenticate with; signing goes to `external.sign`. */
export class ExternalKeyPair implements KeyPair {
  comment: string | null = null;
  private constructor(
    /** The public half as the library's own key pair (for verifying and exporting). */
    readonly publicPair: KeyPair,
    readonly external: ExternalP256Key,
  ) {}

  private get inner(): KeyPair {
    return this.publicPair;
  }

  static async create(external: ExternalP256Key): Promise<ExternalKeyPair> {
    const p = external.publicKey;
    if (p.length !== 65 || p[0] !== 4) throw new Error('expected an uncompressed P-256 public key (65 bytes starting with 0x04)');
    const inner = base().createKeyPair();
    const params: ECParameters = {
      curve: { name: 'nistp256', oid: '1.2.840.10045.3.1.7' },
      x: SshBigInt.fromBytes(Buffer.from(p.subarray(1, 33)), { unsigned: true }),
      y: SshBigInt.fromBytes(Buffer.from(p.subarray(33, 65)), { unsigned: true }),
    };
    await inner.importParameters(params);
    return new ExternalKeyPair(inner, external);
  }

  get keyAlgorithmName(): string {
    return this.inner.keyAlgorithmName;
  }
  get hasPublicKey(): boolean {
    return true;
  }
  /** The private key exists (on the device's hardware): the library may ask it to sign. */
  get hasPrivateKey(): boolean {
    return true;
  }
  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(new Error('an external key cannot be changed'));
  }
  getPublicKeyBytes(algorithmName?: string): Promise<Buffer | null> {
    return this.inner.getPublicKeyBytes(algorithmName);
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('an external key is made by its keystore'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('an external key cannot be changed'));
  }
  exportParameters(): Promise<ECParameters> {
    return this.inner.exportParameters() as Promise<ECParameters>;
  }
  dispose(): void {
    this.inner.dispose();
  }
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` to its two integers (big-endian, maybe with a leading 0). */
export function derToRs(der: Uint8Array): [Uint8Array, Uint8Array] {
  let i = 0;
  const fail = (): never => {
    throw new Error('not a DER ECDSA signature');
  };
  const len = (): number => {
    let n = der[i++] ?? fail();
    if (n & 0x80) {
      const bytes = n & 0x7f;
      if (bytes < 1 || bytes > 2) fail();
      n = 0;
      for (let k = 0; k < bytes; k++) n = (n << 8) | (der[i++] ?? fail());
    }
    return n;
  };
  if (der[i++] !== 0x30) fail();
  const end = len() + i;
  if (end !== der.length) fail();
  const int = (): Uint8Array => {
    if (der[i++] !== 0x02) fail();
    const n = len();
    if (n < 1 || i + n > end) fail();
    const v = der.subarray(i, i + n);
    i += n;
    return v;
  };
  const r = int();
  const s = int();
  if (i !== end) fail();
  return [r, s];
}

class ExternalSigner implements Signer {
  /** Two mpints of up to 33 bytes, each with a 4-byte length (as the library's own signer). */
  readonly digestLength = (4 + 1 + 32) * 2;
  constructor(private readonly key: ExternalKeyPair) {}
  async sign(data: Buffer): Promise<Buffer> {
    const [r, s] = derToRs(await this.key.external.sign(new Uint8Array(data)));
    const w = new SshDataWriter(Buffer.alloc(this.digestLength));
    w.writeBigInt(SshBigInt.fromBytes(Buffer.from(r), { unsigned: true }));
    w.writeBigInt(SshBigInt.fromBytes(Buffer.from(s), { unsigned: true }));
    return w.toBuffer();
  }
  dispose(): void {}
}

/**
 * The library's ECDSA P-256, except that external keys sign through their keystore. Put first in
 * the session's public key algorithms (the library takes the first one matching a key's type).
 */
export class ExternalAwareEcdsaP256 extends PublicKeyAlgorithm {
  private readonly inner = base();
  constructor() {
    super(ECDSA_P256, ECDSA_P256, 'SHA2-256');
  }
  createKeyPair(): KeyPair {
    return this.inner.createKeyPair();
  }
  generateKeyPair(): Promise<KeyPair> {
    return this.inner.generateKeyPair();
  }
  createSigner(keyPair: KeyPair): Signer {
    return keyPair instanceof ExternalKeyPair ? new ExternalSigner(keyPair) : this.inner.createSigner(keyPair);
  }
  createVerifier(keyPair: KeyPair): Verifier {
    return this.inner.createVerifier(keyPair instanceof ExternalKeyPair ? keyPair.publicPair : keyPair);
  }
}

/**
 * Checking an OpenSSH signature (PROTOCOL.sshsig, what `ssh-keygen -Y verify` checks) in the app,
 * with Web Crypto: the team library shows "Signed by …, verified" only when a runbook's signature
 * checks out against a key the user chose to trust (signing/trust.ts). Key types: ssh-ed25519,
 * ecdsa-sha2-nistp256/384/521, rsa-sha2-256/512 signatures of ssh-rsa keys, and security keys
 * and passkeys (sk-ssh-ed25519, sk-ecdsa-sha2-nistp256, webauthn-sk-ecdsa-sha2-nistp256: the
 * app's own passkey signatures). Anything else, or a runtime without Web Crypto, is "can't check".
 */
import { SIGNATURE_NAMESPACE } from '@md-runbook/core/signing';
import { sha256Bytes } from '@md-runbook/core/sha256';
import { Buffer } from 'buffer';

/** An SSH wire-format reader (RFC 4251 strings, uint32, bytes). */
class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  get done(): boolean {
    return this.at === this.b.length;
  }
  u8(): number {
    if (this.at + 1 > this.b.length) throw new Error('short');
    return this.b[this.at++]!;
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error('short');
    const v = ((this.b[this.at]! << 24) | (this.b[this.at + 1]! << 16) | (this.b[this.at + 2]! << 8) | this.b[this.at + 3]!) >>> 0;
    this.at += 4;
    return v;
  }
  raw(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error('short');
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  bytes(): Uint8Array {
    return this.raw(this.u32());
  }
  text(): string {
    return new TextDecoder().decode(this.bytes());
  }
}

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const str = (b: Uint8Array | string): Uint8Array => {
  const v = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  return cat(u32(v.length), v);
};
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
/** Web Crypto takes ArrayBuffer-backed views; `subarray`s of a Buffer may not be. */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

const MAGIC = new TextEncoder().encode('SSHSIG');

export interface Sshsig {
  /** The signer's public key blob (what allowed_signers lists, base64-decoded). */
  publicKey: Uint8Array;
  keyType: string;
  namespace: string;
  hashAlgorithm: string;
  /** The signature blob: its algorithm name, then the algorithm's data. */
  signature: Uint8Array;
  reserved: Uint8Array;
}

/** The parts of a base64 SSHSIG blob (the armored signature without its BEGIN/END lines), or undefined. */
export function parseSshsig(b64: string): Sshsig | undefined {
  try {
    const blob = new Uint8Array(Buffer.from(b64, 'base64'));
    if (!equal(blob.subarray(0, 6), MAGIC)) return undefined;
    const r = new Reader(blob.subarray(6));
    if (r.u32() !== 1) return undefined;
    const publicKey = r.bytes();
    const namespace = r.text();
    const reserved = r.bytes();
    const hashAlgorithm = r.text();
    const signature = r.bytes();
    if (!r.done) return undefined;
    return { publicKey, keyType: new Reader(publicKey).text(), namespace, reserved, hashAlgorithm, signature };
  } catch {
    return undefined;
  }
}

/** `SHA256:…`, as `ssh-keygen -l` shows a key. */
export function keyFingerprint(publicKey: Uint8Array): string {
  return 'SHA256:' + Buffer.from(sha256Bytes(publicKey)).toString('base64').replace(/=+$/, '');
}

const CURVES: Record<string, { curve: string; hash: string; size: number }> = {
  nistp256: { curve: 'P-256', hash: 'SHA-256', size: 32 },
  nistp384: { curve: 'P-384', hash: 'SHA-384', size: 48 },
  nistp521: { curve: 'P-521', hash: 'SHA-512', size: 66 },
};

/** `mpint r ‖ mpint s` (SSH's ECDSA signature) as Web Crypto's fixed-size `r ‖ s`. */
function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const r = new Reader(sig);
  const fit = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const t = v.subarray(i);
    if (t.length > size) throw new Error('bad ecdsa signature');
    return cat(new Uint8Array(size - t.length), t);
  };
  const out = cat(fit(r.bytes()), fit(r.bytes()));
  if (!r.done) throw new Error('bad ecdsa signature');
  return own(out);
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** SK keys: whether the authenticator saw the user (OpenSSH's default; `no-touch-required` is not honoured). */
const FLAG_USER_PRESENT = 0x01;
/** WebAuthn authenticator data flags: attested credential data (never in an assertion), extensions present. */
const FLAG_ATTESTED_DATA = 0x40;
const FLAG_EXTENSIONS = 0x80;
/** The smallest RSA modulus accepted, in bits. */
export const MIN_RSA_BITS = 2048;

/** Why a signature can't be checked on this device (no Web Crypto, a key type or algorithm it lacks): "can't check", not "bad". */
export class CannotCheck extends Error {}

/** `SHA-256`/`SHA-512` for the SSHSIG hash names md-runbook accepts. */
export const sshsigHash = (name: string): 'SHA-256' | 'SHA-512' | undefined =>
  name === 'sha512' ? 'SHA-512' : name === 'sha256' ? 'SHA-256' : undefined;

/** Bits of an unsigned big-endian number (an mpint's magnitude). */
function bitLength(v: Uint8Array): number {
  let i = 0;
  while (i < v.length && v[i] === 0) i++;
  if (i === v.length) return 0;
  return (v.length - i - 1) * 8 + (32 - Math.clz32(v[i]!));
}

/**
 * Whether `signature` (the SSHSIG blob, base64) is a valid signature of `message` in
 * md-runbook's namespace by the key it names. `false` for a bad, malformed or foreign signature;
 * throws CannotCheck only when it can't be checked here (no Web Crypto, a key type or algorithm
 * this device lacks: Web Crypto's NotSupportedError).
 */
export async function verifySshsig(
  b64: string,
  message: string,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<boolean> {
  const s = parseSshsig(b64);
  if (!s || s.namespace !== SIGNATURE_NAMESPACE) return false;
  if (!subtle) throw new CannotCheck('no Web Crypto');
  const hashName = sshsigHash(s.hashAlgorithm);
  if (!hashName) return false;
  try {
    const digest = new Uint8Array(await subtle.digest(hashName, own(new TextEncoder().encode(message))));
    // What the key signed (PROTOCOL.sshsig): the preamble, then the namespace, reserved, hash name and hash.
    const signed = cat(MAGIC, str(s.namespace), str(s.reserved), str(s.hashAlgorithm), str(digest));
    const result = await check(s, signed, subtle);
    return result === true;
  } catch (e) {
    // Only a missing algorithm is "can't check"; a malformed key or signature is a bad signature.
    if (e instanceof CannotCheck) throw e;
    if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NotSupportedError') {
      throw new CannotCheck(e instanceof Error ? e.message : 'not supported');
    }
    return false;
  }
}

/** The key's check of the signed data; throws on anything malformed (the caller makes that `false`). */
async function check(s: Sshsig, signed: Uint8Array, subtle: SubtleCrypto): Promise<boolean> {
  const key = new Reader(s.publicKey);
  const keyType = key.text();
  const sig = new Reader(s.signature);
  const sigType = sig.text();
  const sigData = sig.bytes();
  /** No bytes after the last field, in the key and in the signature (OpenSSH: SSH_ERR_UNEXPECTED_TRAILING_DATA). */
  const end = (): boolean => key.done && sig.done;
  switch (keyType) {
    case 'ssh-ed25519': {
      if (sigType !== keyType) return false;
      const pk = key.bytes();
      if (!end()) return false;
      const k = await subtle.importKey('raw', own(pk), { name: 'Ed25519' }, false, ['verify']);
      return subtle.verify({ name: 'Ed25519' }, k, own(sigData), own(signed));
    }
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521': {
      if (sigType !== keyType) return false;
      const curveName = key.text();
      const c = CURVES[curveName];
      if (!c || keyType !== `ecdsa-sha2-${curveName}`) return false;
      const point = key.bytes();
      if (!end()) return false;
      const k = await subtle.importKey('raw', own(point), { name: 'ECDSA', namedCurve: c.curve }, false, ['verify']);
      return subtle.verify({ name: 'ECDSA', hash: c.hash }, k, ecdsaRaw(sigData, c.size), own(signed));
    }
    case 'ssh-rsa': {
      // SSHSIG never uses SHA-1 (ssh-rsa signatures).
      const hash = sigType === 'rsa-sha2-512' ? 'SHA-512' : sigType === 'rsa-sha2-256' ? 'SHA-256' : undefined;
      if (!hash) return false;
      const e = key.bytes();
      const n = key.bytes();
      if (!end() || bitLength(n) < MIN_RSA_BITS) return false;
      const strip = (v: Uint8Array): Uint8Array => (v[0] === 0 ? v.subarray(1) : v);
      const k = await subtle.importKey(
        'jwk',
        { kty: 'RSA', e: b64url(strip(e)), n: b64url(strip(n)), ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash },
        false,
        ['verify'],
      );
      return subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, k, own(sigData), own(signed));
    }
    case 'sk-ssh-ed25519@openssh.com': {
      if (sigType !== keyType) return false;
      const pk = key.bytes();
      const application = key.bytes();
      const flags = sig.u8();
      const counter = sig.raw(4);
      if (!end() || !(flags & FLAG_USER_PRESENT)) return false;
      const k = await subtle.importKey('raw', own(pk), { name: 'Ed25519' }, false, ['verify']);
      const data = cat(sha256Bytes(application), new Uint8Array([flags]), counter, sha256Bytes(signed));
      return subtle.verify({ name: 'Ed25519' }, k, own(sigData), own(data));
    }
    case 'sk-ecdsa-sha2-nistp256@openssh.com': {
      if (key.text() !== 'nistp256') return false;
      const point = key.bytes();
      const application = key.bytes();
      const flags = sig.u8();
      const counter = sig.raw(4);
      if (!(flags & FLAG_USER_PRESENT)) return false;
      let data: Uint8Array;
      if (sigType === keyType) {
        if (!end()) return false;
        data = cat(sha256Bytes(application), new Uint8Array([flags]), counter, sha256Bytes(signed));
      } else if (sigType === 'webauthn-sk-ecdsa-sha2-nistp256@openssh.com') {
        // A passkey: the browser signed authenticator data ‖ SHA-256(client data), and the client
        // data carries what SSH signs as its challenge (PROTOCOL.u2f; sshd compares this preamble).
        const origin = sig.text();
        const clientData = sig.bytes();
        const extensions = sig.bytes();
        if (!end()) return false;
        // As ssh-ecdsa-sk.c: no quote in the origin, no attested data, extensions flagged iff present.
        if (origin.includes('"') || flags & FLAG_ATTESTED_DATA) return false;
        if (Boolean(flags & FLAG_EXTENSIONS) !== extensions.length > 0) return false;
        const preamble = new TextEncoder().encode(`{"type":"webauthn.get","challenge":"${b64url(signed)}","origin":"${origin}"`);
        if (!equal(clientData.subarray(0, preamble.length), preamble)) return false;
        data = cat(sha256Bytes(application), new Uint8Array([flags]), counter, extensions, sha256Bytes(clientData));
      } else return false;
      const k = await subtle.importKey('raw', own(point), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, ecdsaRaw(sigData, 32), own(data));
    }
    default:
      throw new CannotCheck(`can't check ${keyType} signatures`);
  }
}

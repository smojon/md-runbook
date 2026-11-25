/**
 * OpenSSH user certificates: a company CA signs the user's public key for a time (hours to
 * weeks); sshd trusts the CA (TrustedUserCAKeys), so no authorized_keys line per key.
 *
 * Format: PROTOCOL.certkeys / draft-miller-ssh-cert. The certificate is the public key blob sent
 * in the login; the signature is the plain key's (draft §3.2): `ssh-ed25519`, `ecdsa-sha2-…`, and
 * for RSA `rsa-sha2-512` under the login algorithm `rsa-sha2-512-cert-v01@openssh.com` (never
 * SHA-1 `ssh-rsa`). sshd checks the CA's signature, the principals and the dates; the client only
 * reads them, to show them and to warn before expiry.
 *
 * Not here: security-key certificates (sk-…): not checked against OpenSSH with passkeys.
 */
import type { KeyPair, SshSessionConfiguration, Signer, Verifier } from '@microsoft/dev-tunnels-ssh';
import { PublicKeyAlgorithm } from '@microsoft/dev-tunnels-ssh';
import { sha256Bytes } from '@md-runbook/core/sha256';
import { Buffer } from 'buffer';

interface CertSpec {
  /** The plain key type the certificate is for. */
  plain: string;
  /** The login (userauth) algorithm name. */
  login: string;
  /** The plain algorithm whose signer and signature name are used. */
  signature: string;
}

/** The certificate types this client logs in with. RSA only with SHA-512. */
export const CERT_TYPES: Readonly<Record<string, CertSpec>> = {
  'ssh-ed25519-cert-v01@openssh.com': { plain: 'ssh-ed25519', login: 'ssh-ed25519-cert-v01@openssh.com', signature: 'ssh-ed25519' },
  'ecdsa-sha2-nistp256-cert-v01@openssh.com': {
    plain: 'ecdsa-sha2-nistp256',
    login: 'ecdsa-sha2-nistp256-cert-v01@openssh.com',
    signature: 'ecdsa-sha2-nistp256',
  },
  'ecdsa-sha2-nistp384-cert-v01@openssh.com': {
    plain: 'ecdsa-sha2-nistp384',
    login: 'ecdsa-sha2-nistp384-cert-v01@openssh.com',
    signature: 'ecdsa-sha2-nistp384',
  },
  'ecdsa-sha2-nistp521-cert-v01@openssh.com': {
    plain: 'ecdsa-sha2-nistp521',
    login: 'ecdsa-sha2-nistp521-cert-v01@openssh.com',
    signature: 'ecdsa-sha2-nistp521',
  },
  'ssh-rsa-cert-v01@openssh.com': { plain: 'ssh-rsa', login: 'rsa-sha2-512-cert-v01@openssh.com', signature: 'rsa-sha2-512' },
};

export const isCertType = (type: string): boolean => Object.prototype.hasOwnProperty.call(CERT_TYPES, type);

const USER_CERT = 1;
/** Bigger than any real certificate (an RSA 16384 key and CA fit easily). */
const MAX_CERT_BYTES = 16 * 1024;

export interface SshCertificate {
  /** `ssh-ed25519-cert-v01@openssh.com` and the like. */
  type: string;
  /** The plain key type (`ssh-ed25519`). */
  keyType: string;
  /** The whole certificate: the public key blob of a login. */
  blob: Buffer;
  /** The certified key's plain public key blob (as in an authorized_keys line). */
  publicKey: Buffer;
  /** The CA's serial number, in decimal. */
  serial: string;
  /** The key ID (`ssh-keygen -I`): what sshd logs. */
  keyId: string;
  /** The users the certificate may log in as; empty means any (sshd refuses those by default). */
  principals: string[];
  /** Seconds since 1970; 0 means always. */
  validAfter: number;
  /** Seconds since 1970; Infinity means forever. */
  validBefore: number;
  /** force-command, source-address and the like, with their values. */
  criticalOptions: Record<string, string>;
  /** permit-pty and the like. */
  extensions: string[];
  /** The CA's key fingerprint, `SHA256:…` as ssh-keygen -l shows it. */
  caFingerprint: string;
  /** The CA's public key blob. */
  caKey: Buffer;
  /** The CA's signature blob (`string type, string signature`). */
  caSignature: Buffer;
  /** What the CA signed: the certificate up to its signature field. */
  signed: Buffer;
  /** The comment of the line it was read from. */
  comment: string;
}

class Reader {
  at = 0;
  constructor(private readonly b: Buffer) {}
  private need(n: number): void {
    if (this.at + n > this.b.length) throw new Error('not an OpenSSH certificate (cut short)');
  }
  u32(): number {
    this.need(4);
    const n = this.b.readUInt32BE(this.at);
    this.at += 4;
    return n;
  }
  /** A uint64 as two halves: exact up to 2^53, Infinity above. */
  u64(): { hi: number; lo: number; value: number } {
    const hi = this.u32();
    const lo = this.u32();
    const value = hi >= 0x200000 ? Infinity : hi * 0x100000000 + lo;
    return { hi, lo, value };
  }
  bytes(): Buffer {
    const n = this.u32();
    this.need(n);
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(v);
  }
  text(): string {
    return this.bytes().toString('utf8');
  }
  get done(): boolean {
    return this.at === this.b.length;
  }
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const sshString = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
  return Buffer.concat([u32(v.length), v]);
};

/** The strings packed in one string (principals). */
function strings(b: Buffer): string[] {
  const r = new Reader(b);
  const out: string[] = [];
  while (!r.done) out.push(r.text());
  return out;
}

/** Name/value pairs packed in one string (critical options, extensions); a value is itself a string, maybe empty. */
function options(b: Buffer): Record<string, string> {
  const r = new Reader(b);
  // No prototype: a name such as __proto__ is just a name.
  const out = Object.create(null) as Record<string, string>;
  while (!r.done) {
    const name = r.text();
    const data = r.bytes();
    // A value is a string inside the data (draft §2.2); empty data means no value.
    out[name] = data.length === 0 ? '' : new Reader(data).text();
  }
  return out;
}

const decimal = (hi: number, lo: number): string => (BigInt(hi) * BigInt(0x100000000) + BigInt(lo)).toString();

/** `SHA256:…` of a public key blob, unpadded base64 as ssh-keygen -l prints it. */
export function keyFingerprint(blob: Uint8Array): string {
  return `SHA256:${Buffer.from(sha256Bytes(blob)).toString('base64').replace(/=+$/, '')}`;
}

/**
 * A user certificate from its `…-cert.pub` line (`type base64 comment`), or the blob itself.
 * Throws with a reason for anything else: a plain key, a host certificate, an unknown type.
 */
export function parseCertificate(input: string | Uint8Array): SshCertificate {
  let blob: Buffer;
  let lineType: string | undefined;
  let comment = '';
  if (typeof input === 'string') {
    const parts = input.trim().split(/\s+/);
    if (parts.length < 2) throw new Error('not an OpenSSH certificate: expected the line of a …-cert.pub file');
    lineType = parts[0]!;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]!)) throw new Error('not an OpenSSH certificate: the key is not base64');
    blob = Buffer.from(parts[1]!, 'base64');
    comment = parts.slice(2).join(' ');
  } else blob = Buffer.from(input);
  if (blob.length > MAX_CERT_BYTES) throw new Error('not an OpenSSH certificate: too large');
  const r = new Reader(blob);
  const type = r.text();
  if (lineType !== undefined && lineType !== type) throw new Error(`not an OpenSSH certificate: the line says ${lineType}, the key is ${type}`);
  if (!type.endsWith('-cert-v01@openssh.com')) throw new Error(`not a certificate but a plain key (${type}): use the …-cert.pub file`);
  const spec = CERT_TYPES[type];
  if (!spec) throw new Error(`this certificate type is not supported: ${type}`);
  r.bytes(); // nonce
  const keyStart = r.at;
  if (spec.plain === 'ssh-ed25519') {
    if (r.bytes().length !== 32) throw new Error('not an OpenSSH certificate: bad Ed25519 key');
  } else if (spec.plain === 'ssh-rsa') {
    r.bytes(); // e
    r.bytes(); // n
  } else {
    const curve = r.text();
    if (`ecdsa-sha2-${curve}` !== spec.plain) throw new Error(`not an OpenSSH certificate: curve ${curve} in a ${type}`);
    r.bytes(); // Q
  }
  const keyFields = blob.subarray(keyStart, r.at);
  const serial = r.u64();
  const certType = r.u32();
  if (certType !== USER_CERT) throw new Error('this is a host certificate, not a user certificate');
  const keyId = r.text();
  const principals = strings(r.bytes());
  const validAfter = r.u64().value;
  const before = r.u64();
  const criticalOptions = options(r.bytes());
  const extensions = Object.keys(options(r.bytes()));
  r.bytes(); // reserved
  const caKey = r.bytes();
  const signedEnd = r.at;
  const caSignature = r.bytes();
  if (!r.done) throw new Error('not an OpenSSH certificate: data after the signature');
  return {
    type,
    keyType: spec.plain,
    blob,
    publicKey: Buffer.concat([sshString(spec.plain), keyFields]),
    serial: decimal(serial.hi, serial.lo),
    keyId,
    principals,
    validAfter,
    validBefore: before.hi === 0xffffffff && before.lo === 0xffffffff ? Infinity : before.value,
    criticalOptions,
    extensions,
    caFingerprint: keyFingerprint(caKey),
    caKey,
    caSignature,
    signed: Buffer.from(blob.subarray(0, signedEnd)),
    comment,
  };
}

/** `valid`: the CA's signature checks out; `invalid`: it doesn't; `unchecked`: this device can't check it. */
export type CaSignatureCheck = 'valid' | 'invalid' | 'unchecked';

/** A copy in an ArrayBuffer of its own, for Web Crypto. */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/** `mpint r ‖ mpint s` as Web Crypto's fixed-size `r ‖ s`. */
function ecdsaRaw(sig: Buffer, size: number): Uint8Array<ArrayBuffer> {
  const r = new Reader(sig);
  const fit = (v: Buffer): Buffer => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const t = v.subarray(i);
    if (t.length > size) throw new Error('bad ECDSA signature');
    return Buffer.concat([Buffer.alloc(size - t.length), t]);
  };
  const out = Buffer.concat([fit(r.bytes()), fit(r.bytes())]);
  if (!r.done) throw new Error('bad ECDSA signature');
  return own(out);
}

const CURVES: Record<string, { curve: string; hash: string; size: number }> = {
  nistp256: { curve: 'P-256', hash: 'SHA-256', size: 32 },
  nistp384: { curve: 'P-384', hash: 'SHA-384', size: 48 },
  nistp521: { curve: 'P-521', hash: 'SHA-512', size: 66 },
};

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Check the CA's signature with Web Crypto (Node, browsers, the app's quick-crypto): Ed25519,
 * ECDSA P-256/384/521, RSA with SHA-256/512. Only for what the screen shows: sshd checks it again
 * against the CAs it trusts. `unchecked` without Web Crypto, for SHA-1 RSA (OpenSSH refuses it
 * by default) or an algorithm this device lacks.
 */
export async function checkCaSignature(cert: SshCertificate, subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle): Promise<CaSignatureCheck> {
  if (!subtle) return 'unchecked';
  try {
    const key = new Reader(cert.caKey);
    const keyType = key.text();
    const sig = new Reader(cert.caSignature);
    const sigType = sig.text();
    const sigData = sig.bytes();
    if (!sig.done) return 'invalid';
    const data = own(cert.signed);
    if (keyType === 'ssh-ed25519') {
      const pk = key.bytes();
      if (sigType !== keyType || !key.done) return 'invalid';
      const k = await subtle.importKey('raw', own(pk), { name: 'Ed25519' }, false, ['verify']);
      return (await subtle.verify({ name: 'Ed25519' }, k, own(sigData), data)) ? 'valid' : 'invalid';
    }
    if (keyType.startsWith('ecdsa-sha2-')) {
      const curveName = key.text();
      const c = Object.prototype.hasOwnProperty.call(CURVES, curveName) ? CURVES[curveName] : undefined;
      const point = key.bytes();
      if (!c || sigType !== keyType || keyType !== `ecdsa-sha2-${curveName}` || !key.done) return 'invalid';
      const k = await subtle.importKey('raw', own(point), { name: 'ECDSA', namedCurve: c.curve }, false, ['verify']);
      return (await subtle.verify({ name: 'ECDSA', hash: c.hash }, k, ecdsaRaw(sigData, c.size), data)) ? 'valid' : 'invalid';
    }
    if (keyType === 'ssh-rsa') {
      const hash = sigType === 'rsa-sha2-512' ? 'SHA-512' : sigType === 'rsa-sha2-256' ? 'SHA-256' : undefined;
      if (!hash) return sigType === 'ssh-rsa' ? 'unchecked' : 'invalid';
      const e = key.bytes();
      const n = key.bytes();
      if (!key.done) return 'invalid';
      const strip = (v: Buffer): Buffer => (v[0] === 0 ? v.subarray(1) : v);
      const k = await subtle.importKey('jwk', { kty: 'RSA', e: b64url(strip(e)), n: b64url(strip(n)), ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      return (await subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, k, own(sigData), data)) ? 'valid' : 'invalid';
    }
    return 'unchecked';
  } catch (e) {
    // A missing algorithm is "can't check"; anything malformed is a bad signature.
    if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NotSupportedError') return 'unchecked';
    return 'invalid';
  }
}

/** The certificate as a `…-cert.pub` line. */
export function certificateLine(cert: SshCertificate): string {
  return `${cert.type} ${cert.blob.toString('base64')}${cert.comment ? ` ${cert.comment}` : ''}`;
}

export type CertificateState = 'not-yet' | 'valid' | 'expiring' | 'expired';

/**
 * Where the certificate is in its validity at `now` (ms). `expiring`: in its last quarter, and at
 * most a day left (a week-long certificate warns a day ahead, an 8-hour one 2 hours ahead).
 */
export function certificateState(cert: Pick<SshCertificate, 'validAfter' | 'validBefore'>, now = Date.now()): CertificateState {
  const s = now / 1000;
  if (s < cert.validAfter) return 'not-yet';
  if (s >= cert.validBefore) return 'expired';
  if (cert.validBefore === Infinity) return 'valid';
  const lifetime = cert.validBefore - cert.validAfter;
  return cert.validBefore - s <= Math.min(86400, lifetime / 4) ? 'expiring' : 'valid';
}

/** Seconds JavaScript dates reach (year 275760): a certificate may say more (forever, or garbage). */
const MAX_DATE_SECONDS = 8.64e12;

/** `2026-11-25T14:05:00.000Z`, or `never`/`far in the future` where a date can't say it. */
export function utcTime(seconds: number): string {
  if (seconds === Infinity) return 'never';
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DATE_SECONDS) return 'far in the future';
  return new Date(seconds * 1000).toISOString();
}

/** Clock skew allowed between this device and the server when a certificate is judged by date. */
export const CLOCK_SKEW_SECONDS = 300;

/**
 * Whether a login should try this certificate: within its dates, give or take the clock skew
 * (sshd judges by its own clock). Principals are not judged: AuthorizedPrincipalsFile may map them.
 */
export function certificateUsable(cert: Pick<SshCertificate, 'validAfter' | 'validBefore'>, now = Date.now()): boolean {
  const s = now / 1000;
  return cert.validAfter - CLOCK_SKEW_SECONDS <= s && s < cert.validBefore + CLOCK_SKEW_SECONDS;
}

/** The certificate a key sends (an agent's certificate identity, a CertKeyPair); undefined for a plain key or an unreadable one. */
export async function certificateOf(key: KeyPair): Promise<SshCertificate | undefined> {
  if (key instanceof CertKeyPair) return key.certificate;
  if (!isCertType(key.keyAlgorithmName)) return undefined;
  try {
    const blob = await key.getPublicKeyBytes();
    return blob ? parseCertificate(blob) : undefined;
  } catch {
    return undefined;
  }
}

export interface LoginKeyChoice<K extends KeyPair> {
  /** The agent's keys, in its order (certificates and plain keys). */
  agent: readonly K[];
  /** The client's own key, and its certificate on it (a CertKeyPair). */
  own?: K;
  ownCert?: K;
  /** Plain agent keys tried, as before certificates (servers allow about 6 tries). */
  maxPlainAgent?: number;
  /** Certificates tried before them, the agent's and the own one together. */
  maxCertificates?: number;
  now?: number;
}

/**
 * The keys a login tries, in order: up to 2 certificates that are within their dates (the own
 * one keeps a place), then up to 5 plain agent keys and the own key, as without certificates.
 * Certificates come on top: a host that doesn't trust the CA still gets the plain keys it got
 * before (sshd's MaxAuthTries, 6 by default, counts each key tried).
 */
export async function chooseLoginKeys<K extends KeyPair>(c: LoginKeyChoice<K>): Promise<K[]> {
  const now = c.now ?? Date.now();
  const maxCerts = c.maxCertificates ?? 2;
  const usable = async (k: K): Promise<boolean> => {
    const cert = await certificateOf(k);
    return cert !== undefined && certificateUsable(cert, now);
  };
  const agentCerts: K[] = [];
  const plain: K[] = [];
  for (const k of c.agent) {
    if (!isCertType(k.keyAlgorithmName)) plain.push(k);
    else if (await usable(k)) agentCerts.push(k);
  }
  const ownCert = c.ownCert && (await usable(c.ownCert)) ? [c.ownCert] : [];
  const certs = [...agentCerts.slice(0, Math.max(0, maxCerts - ownCert.length)), ...ownCert].slice(0, maxCerts);
  return [...certs, ...plain.slice(0, c.maxPlainAgent ?? 5), ...(c.own ? [c.own] : [])];
}

/** The certificate is for this public key blob (compared with the plain key's blob). */
export function certificateMatches(cert: SshCertificate, publicKeyBlob: Uint8Array): boolean {
  return cert.publicKey.equals(Buffer.from(publicKeyBlob));
}

/**
 * A key the client already has (its own, a hardware key) with a certificate: the login sends the
 * certificate, the key signs. Refuses a certificate for another key.
 */
export class CertKeyPair implements KeyPair {
  comment: string | null;
  private constructor(
    readonly inner: KeyPair,
    readonly certificate: SshCertificate,
  ) {
    this.comment = certificate.keyId || null;
  }

  static async create(inner: KeyPair, cert: SshCertificate | string): Promise<CertKeyPair> {
    const c = typeof cert === 'string' ? parseCertificate(cert) : cert;
    const own = await inner.getPublicKeyBytes();
    if (!own || !certificateMatches(c, own)) throw new Error(`this certificate is for another key (${keyFingerprint(c.publicKey)})`);
    return new CertKeyPair(inner, c);
  }

  get keyAlgorithmName(): string {
    return this.certificate.type;
  }
  get hasPublicKey(): boolean {
    return true;
  }
  get hasPrivateKey(): boolean {
    return this.inner.hasPrivateKey;
  }
  /** The certificate, whatever algorithm asks. */
  getPublicKeyBytes(_algorithmName?: string): Promise<Buffer | null> {
    return Promise.resolve(Buffer.from(this.certificate.blob));
  }
  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(new Error('a certificate cannot be changed'));
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('a certificate is issued by its CA'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('a certificate cannot be changed'));
  }
  exportParameters(): Promise<never> {
    return Promise.reject(new Error('a certificate cannot be exported'));
  }
  dispose(): void {}
}

/**
 * A certificate login algorithm: the login names the certificate type, the plain algorithm signs
 * (its signer for the inner key; agent keys through the agent) and names the signature.
 */
export class CertAlgorithm extends PublicKeyAlgorithm {
  constructor(
    certType: string,
    login: string,
    readonly plain: PublicKeyAlgorithm,
  ) {
    super(login, certType, plain.hashAlgorithmName);
  }
  createKeyPair(): KeyPair {
    throw new Error('host certificates are not supported');
  }
  generateKeyPair(): Promise<KeyPair> {
    return Promise.reject(new Error('a certificate is issued by its CA'));
  }
  createSigner(keyPair: KeyPair): Signer {
    return this.plain.createSigner(keyPair instanceof CertKeyPair ? keyPair.inner : keyPair);
  }
  createVerifier(): Verifier {
    throw new Error('host certificates are not supported');
  }
  /** The plain key's signature name (`ssh-ed25519`, `rsa-sha2-512`), as draft §3.2 says. */
  createSignatureData(signature: Buffer): Buffer {
    return this.plain.createSignatureData(signature);
  }
}

/**
 * Add a certificate algorithm for each certificate type whose plain algorithm is configured (after
 * the session's other changes: it signs with what is there). Last in the list, so a server is
 * never asked for a host certificate when it has a plain host key we know.
 */
export function certAlgorithms(config: SshSessionConfiguration): void {
  const list = config.publicKeyAlgorithms;
  for (const [certType, spec] of Object.entries(CERT_TYPES)) {
    if (list.some((a) => a?.keyAlgorithmName === certType)) continue;
    const plain = list.find((a) => a?.name === spec.signature);
    if (plain) list.push(new CertAlgorithm(certType, spec.login, plain));
  }
}

/** Certificates first (stable): sshd counts each key tried (MaxAuthTries, 6 by default). */
export function certificatesFirst<T extends { keyAlgorithmName: string }>(keys: readonly T[]): T[] {
  return [...keys.filter((k) => isCertType(k.keyAlgorithmName)), ...keys.filter((k) => !isCertType(k.keyAlgorithmName))];
}

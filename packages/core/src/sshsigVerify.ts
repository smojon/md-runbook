/**
 * Checking an OpenSSH signature (`ssh-keygen -Y sign`, PROTOCOL.sshsig) without ssh-keygen, for
 * the app: it decides whether it trusts a signed runbook (run reports, runReport.ts) against
 * allowed_signers lines kept in its settings, as `ssh-keygen -Y verify` would against a file.
 * Ed25519 and ECDSA P-256 keys, through Web Crypto (`crypto.subtle`: the web, Node, and
 * react-native-quick-crypto on phones). Other key types, certificates (`cert-authority`) and
 * security-key signatures are not checked here: the signature then counts as not trusted.
 *
 * VS Code and the command line check with ssh-keygen itself (node/sign.ts sshVerify).
 */

/** The parts of Web Crypto this needs. */
export interface SubtleLike {
  importKey(format: 'raw', key: Uint8Array, algorithm: { name: string; namedCurve?: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  verify(algorithm: { name: string; hash?: string }, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes of base64 (padding optional); throws on anything else. */
export function base64Bytes(b64: string): Uint8Array {
  const s = b64.replace(/\s+/g, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let k = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[k++] = (acc >> bits) & 255;
    }
  }
  return out;
}

class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error('SSH signature: too short');
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u32(): number {
    const x = this.bytes(4);
    return ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0;
  }
  string(): Uint8Array {
    return this.bytes(this.u32());
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
  get done(): boolean {
    return this.at === this.b.length;
  }
}

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sshString = (b: Uint8Array): Uint8Array => concat(u32(b.length), b);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const MAGIC = new TextEncoder().encode('SSHSIG');

export interface ParsedSshsig {
  /** The public key blob (SSH wire format), and its type. */
  publicKey: Uint8Array;
  keyType: string;
  namespace: string;
  hash: 'sha256' | 'sha512';
  /** The signature's algorithm and its blob. */
  sigType: string;
  sig: Uint8Array;
}

/** The parts of an SSHSIG blob (base64, or armored with BEGIN/END lines). */
export function parseSshsig(signature: string): ParsedSshsig {
  const armored = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(signature);
  const r = new Reader(base64Bytes(armored ? armored[1]! : signature));
  if (!same(r.bytes(6), MAGIC)) throw new Error('not an SSH signature');
  if (r.u32() !== 1) throw new Error('SSH signature: unknown version');
  const publicKey = r.string();
  const namespace = r.text();
  r.string(); // reserved
  const hash = r.text();
  if (hash !== 'sha256' && hash !== 'sha512') throw new Error(`SSH signature: unknown hash ${hash}`);
  const s = new Reader(r.string());
  if (!r.done) throw new Error('SSH signature: trailing data');
  const sigType = s.text();
  const sig = s.string();
  return { publicKey, keyType: new Reader(publicKey).text(), namespace, hash, sigType, sig };
}

export interface AllowedSigner {
  principals: string[];
  namespaces?: string[];
  validAfter?: string;
  validBefore?: string;
  certAuthority: boolean;
  keyType: string;
  /** The key's base64, as written. */
  key: string;
}

/** Split an allowed_signers line on whitespace outside double quotes. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The entries of allowed_signers text (OpenSSH's format; lines it can't read are left out). */
export function parseAllowedSigners(text: string): AllowedSigner[] {
  const out: AllowedSigner[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const f = fields(line);
    if (f.length < 3) continue;
    const isKeyType = (t: string): boolean => /^(ssh-|ecdsa-sha2-|sk-|webauthn-)/.test(t);
    const hasOptions = !isKeyType(f[1]!);
    const [keyType, key] = hasOptions ? [f[2], f[3]] : [f[1], f[2]];
    if (!keyType || !key || !isKeyType(keyType)) continue;
    const e: AllowedSigner = { principals: f[0]!.split(','), certAuthority: false, keyType, key };
    if (hasOptions) {
      for (const opt of f[1]!.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
        const m = /^([A-Za-z-]+)(?:="?([^"]*)"?)?$/.exec(opt);
        if (!m) continue;
        const name = m[1]!.toLowerCase();
        if (name === 'namespaces') e.namespaces = (m[2] ?? '').split(',');
        else if (name === 'valid-after') e.validAfter = m[2];
        else if (name === 'valid-before') e.validBefore = m[2];
        else if (name === 'cert-authority') e.certAuthority = true;
      }
    }
    out.push(e);
  }
  return out;
}

/** OpenSSH's wildcard patterns (`*`, `?`), as in namespaces= lists. */
const matches = (pattern: string, s: string): boolean => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(s);

/** `YYYYMMDD[HHMM[SS]][Z]` as ms since 1970 (local time without Z, as OpenSSH reads it). */
function signerTime(t: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(Z)?$/i.exec(t);
  if (!m) return undefined;
  const p = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)] as const;
  return m[7] ? Date.UTC(...p) : new Date(...p).getTime();
}

/** An ECDSA mpint (maybe with a leading 0, maybe short) as `len` big-endian bytes. */
function fixed(mpint: Uint8Array, len: number): Uint8Array {
  let b = mpint;
  while (b.length > len && b[0] === 0) b = b.subarray(1);
  if (b.length > len) throw new Error('SSH signature: bad ECDSA value');
  return concat(new Uint8Array(len - b.length), b);
}

/**
 * The principal of `allowed` whose key made `signature` over `message` in `namespace`, or an error
 * saying why there is none: what `ssh-keygen -Y find-principals` then `-Y verify` would say.
 */
export async function verifySshsig(message: string | Uint8Array, signature: string, namespace: string, allowed: string, subtle?: SubtleLike, now = new Date()): Promise<string> {
  const crypto = subtle ?? (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!crypto) throw new Error('no Web Crypto here to check signatures');
  const sig = parseSshsig(signature);
  if (sig.namespace !== namespace) throw new Error(`the signature is for "${sig.namespace}", not "${namespace}"`);
  const keyB64 = toB64(sig.publicKey);
  const entry = parseAllowedSigners(allowed).find(
    (e) =>
      !e.certAuthority &&
      e.key === keyB64 &&
      (!e.namespaces || e.namespaces.some((n) => matches(n, namespace))) &&
      (!e.validAfter || (signerTime(e.validAfter) ?? Infinity) <= now.getTime()) &&
      (!e.validBefore || (signerTime(e.validBefore) ?? -Infinity) > now.getTime()),
  );
  if (!entry) throw new Error('no trusted signer has this key (for this namespace, at this time)');
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const digest = new Uint8Array(await crypto.digest(sig.hash === 'sha256' ? 'SHA-256' : 'SHA-512', data));
  const enc = new TextEncoder();
  const signed = concat(MAGIC, sshString(enc.encode(namespace)), sshString(new Uint8Array(0)), sshString(enc.encode(sig.hash)), sshString(digest));
  const pub = new Reader(sig.publicKey);
  pub.text();
  let ok: boolean;
  if (sig.keyType === 'ssh-ed25519' && sig.sigType === 'ssh-ed25519') {
    const key = await crypto.importKey('raw', pub.string(), { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.verify({ name: 'Ed25519' }, key, sig.sig, signed);
  } else if (sig.keyType === 'ecdsa-sha2-nistp256' && sig.sigType === 'ecdsa-sha2-nistp256') {
    if (pub.text() !== 'nistp256') throw new Error('SSH signature: bad P-256 key');
    const key = await crypto.importKey('raw', pub.string(), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const rs = new Reader(sig.sig);
    const raw = concat(fixed(rs.string(), 32), fixed(rs.string(), 32));
    ok = await crypto.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed);
  } else {
    throw new Error(`${sig.sigType} signatures are not checked here (Ed25519 and ECDSA P-256 are)`);
  }
  if (!ok) throw new Error('the signature does not verify');
  return entry.principals[0]!;
}

function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : B64[c & 63]!;
  }
  return out;
}

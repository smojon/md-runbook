/**
 * Log in with the keys of an OpenSSH agent (ssh-agent, Windows OpenSSH's agent service, 1Password
 * and the like): the agent signs, the private key never reaches JavaScript. Node only (a Unix
 * socket or a Windows named pipe); exported from `@md-runbook/ssh/node`.
 *
 * Protocol: draft-ietf-sshm-ssh-agent. Each message is a uint32 length, a type byte, the contents.
 * Ed25519, ECDSA (P-256, P-384, P-521) and RSA keys (signed as rsa-sha2-512). The library has no
 * Ed25519, so `agentAlgorithms` adds it: agent keys sign with it, and an Ed25519 host key is
 * verified with Node's crypto.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { Buffer } from 'buffer';
import { KeyPair, PublicKeyAlgorithm, Signer, SshSessionConfiguration, Verifier } from '@microsoft/dev-tunnels-ssh';

/** Windows OpenSSH's agent service (PowerShell/openssh-portable, ssh-agent/agent.c AGENT_PIPE_ID). */
export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

const FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;
const RSA_SHA2_512 = 4;
/** An agent message is small; a bigger length is a broken or hostile answer. */
const MAX_MESSAGE = 256 * 1024;

export const ED25519 = 'ssh-ed25519';
const RSA = 'ssh-rsa';
/** The key types an agent key may have here (the library's, and Ed25519). */
const USABLE = new Set([ED25519, RSA, 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);

/** Where the agent listens: SSH_AUTH_SOCK, else Windows OpenSSH's pipe on Windows. */
export function agentPath(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | undefined {
  const sock = env.SSH_AUTH_SOCK?.trim();
  if (sock) return sock;
  return platform === 'win32' ? WINDOWS_AGENT_PIPE : undefined;
}

export interface AgentIdentity {
  /** The public key blob (`string type, …`), as in an authorized_keys line's base64. */
  blob: Buffer;
  type: string;
  comment: string;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const sshString = (b: Uint8Array): Buffer => Buffer.concat([u32(b.length), Buffer.from(b)]);

/** Reads SSH wire fields; throws on anything short. */
class Reader {
  private at = 0;
  constructor(private readonly b: Buffer) {}
  byte(): number {
    if (this.at + 1 > this.b.length) throw new Error('the agent sent a short message');
    return this.b[this.at++]!;
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error('the agent sent a short message');
    const n = this.b.readUInt32BE(this.at);
    this.at += 4;
    return n;
  }
  bytes(): Buffer {
    const n = this.u32();
    if (this.at + n > this.b.length) throw new Error('the agent sent a short message');
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(v);
  }
}

/** The key type a public key blob starts with. */
export function blobType(blob: Uint8Array): string {
  return new Reader(Buffer.from(blob)).bytes().toString('ascii');
}

/** The identities in an IDENTITIES_ANSWER message body (after the type byte). */
export function parseIdentities(body: Buffer): AgentIdentity[] {
  const r = new Reader(body);
  const n = r.u32();
  if (n > 1000) throw new Error('the agent listed too many keys');
  const out: AgentIdentity[] = [];
  for (let i = 0; i < n; i++) {
    const blob = r.bytes();
    const comment = r.bytes().toString('utf8');
    out.push({ blob, type: blobType(blob), comment });
  }
  return out;
}

/** The signature blob (`string algorithm, string signature`) out of a SIGN_RESPONSE body. */
export function parseSignResponse(body: Buffer): Buffer {
  return new Reader(body).bytes();
}

/** A sign request for `blob`'s key over `data`. RSA keys sign with SHA-512. */
export function signRequest(blob: Uint8Array, data: Uint8Array): Buffer {
  const flags = blobType(blob) === RSA ? RSA_SHA2_512 : 0;
  return Buffer.concat([Buffer.from([SIGN_REQUEST]), sshString(blob), sshString(data), u32(flags)]);
}

/** Talks to one agent; a new connection per request (agents answer in milliseconds). */
export class AgentClient {
  constructor(
    readonly path: string,
    private readonly timeoutMs = 15_000,
  ) {}

  /** The agent's keys that this client can log in with. */
  async identities(): Promise<AgentIdentity[]> {
    const [type, body] = await this.request(Buffer.from([REQUEST_IDENTITIES]));
    if (type !== IDENTITIES_ANSWER) throw new Error('the agent did not list its keys');
    return parseIdentities(body).filter((k) => USABLE.has(k.type));
  }

  /** The agent's signature blob of `data` with the key `blob`. */
  async sign(blob: Uint8Array, data: Uint8Array): Promise<Buffer> {
    const [type, body] = await this.request(signRequest(blob, data));
    if (type === FAILURE) throw new Error('the agent refused to sign (key removed, or confirmation declined)');
    if (type !== SIGN_RESPONSE) throw new Error('the agent did not sign');
    return parseSignResponse(body);
  }

  /** One request, one answer: [type, body]. */
  private request(message: Buffer): Promise<[number, Buffer]> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.path);
      let got = Buffer.alloc(0);
      let done = false;
      const finish = (e?: Error, v?: [number, Buffer]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (e) reject(e);
        else resolve(v!);
      };
      const timer = setTimeout(() => finish(new Error(`the SSH agent did not answer in ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs);
      socket.once('connect', () => socket.write(Buffer.concat([u32(message.length), message])));
      socket.on('data', (d: Buffer) => {
        got = Buffer.concat([got, d]);
        if (got.length < 4) return;
        const n = got.readUInt32BE(0);
        if (n < 1 || n > MAX_MESSAGE) return finish(new Error('the SSH agent sent a broken message'));
        if (got.length < 4 + n) return;
        finish(undefined, [got[4]!, Buffer.from(got.subarray(5, 4 + n))]);
      });
      socket.once('error', (e) => finish(new Error(`no SSH agent at ${this.path} (${e.message})`)));
      socket.once('close', () => finish(new Error('the SSH agent closed the connection')));
    });
  }
}

/** A key of the agent, as a key pair the library can log in with: signing goes to the agent. */
export class AgentKeyPair implements KeyPair {
  comment: string | null;
  constructor(
    readonly agent: AgentClient,
    readonly identity: AgentIdentity,
  ) {
    this.comment = identity.comment || null;
  }
  get keyAlgorithmName(): string {
    return this.identity.type;
  }
  get hasPublicKey(): boolean {
    return true;
  }
  /** The agent holds it: the library may ask it to sign. */
  get hasPrivateKey(): boolean {
    return true;
  }
  getPublicKeyBytes(): Promise<Buffer | null> {
    return Promise.resolve(Buffer.from(this.identity.blob));
  }
  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(new Error('an agent key cannot be changed'));
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('agent keys are added with ssh-add'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('an agent key cannot be changed'));
  }
  exportParameters(): Promise<never> {
    return Promise.reject(new Error('an agent key cannot be exported'));
  }
  dispose(): void {}
}

/** Signs through the agent; returns the bare signature, which the algorithm wraps with its name. */
class AgentSigner implements Signer {
  readonly digestLength = 1024;
  constructor(
    private readonly key: AgentKeyPair,
    private readonly algorithm: string,
  ) {}
  async sign(data: Buffer): Promise<Buffer> {
    const r = new Reader(await this.key.agent.sign(this.key.identity.blob, data));
    const name = r.bytes().toString('ascii');
    if (name !== this.algorithm) throw new Error(`the agent signed with ${name}, not ${this.algorithm}`);
    return r.bytes();
  }
  dispose(): void {}
}

/** The library's algorithm, except that agent keys sign through the agent. */
class AgentAware extends PublicKeyAlgorithm {
  constructor(private readonly inner: PublicKeyAlgorithm) {
    super(inner.name, inner.keyAlgorithmName, inner.hashAlgorithmName);
  }
  createKeyPair(): KeyPair {
    return this.inner.createKeyPair();
  }
  generateKeyPair(bits?: number): Promise<KeyPair> {
    return this.inner.generateKeyPair(bits);
  }
  createSigner(keyPair: KeyPair): Signer {
    return keyPair instanceof AgentKeyPair ? new AgentSigner(keyPair, this.name) : this.inner.createSigner(keyPair);
  }
  createVerifier(keyPair: KeyPair): Verifier {
    return this.inner.createVerifier(keyPair);
  }
}

/** An Ed25519 public key: a host key to verify. */
export class Ed25519PublicKey implements KeyPair {
  comment: string | null = null;
  private blob: Buffer | undefined;
  get keyAlgorithmName(): string {
    return ED25519;
  }
  get hasPublicKey(): boolean {
    return this.blob !== undefined;
  }
  get hasPrivateKey(): boolean {
    return false;
  }
  setPublicKeyBytes(bytes: Buffer): Promise<void> {
    const r = new Reader(Buffer.from(bytes));
    if (r.bytes().toString('ascii') !== ED25519 || r.bytes().length !== 32) return Promise.reject(new Error('not an Ed25519 public key'));
    this.blob = Buffer.from(bytes);
    return Promise.resolve();
  }
  getPublicKeyBytes(): Promise<Buffer | null> {
    return Promise.resolve(this.blob ?? null);
  }
  /** The raw 32-byte key. */
  raw(): Buffer {
    if (!this.blob) throw new Error('no Ed25519 public key');
    const r = new Reader(this.blob);
    r.bytes();
    return r.bytes();
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('Ed25519 keys are not made here'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('not supported for Ed25519'));
  }
  exportParameters(): Promise<never> {
    return Promise.reject(new Error('not supported for Ed25519'));
  }
  dispose(): void {}
}

class Ed25519Verifier implements Verifier {
  readonly digestLength = 64;
  constructor(private readonly key: Ed25519PublicKey) {}
  verify(data: Buffer, signature: Buffer): Promise<boolean> {
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: this.key.raw().toString('base64url') }, format: 'jwk' });
    return Promise.resolve(signature.length === 64 && crypto.verify(null, data, publicKey, signature));
  }
  dispose(): void {}
}

/** `ssh-ed25519`: agent keys sign with it; host keys of the type are verified with Node's crypto. */
export class Ed25519Algorithm extends PublicKeyAlgorithm {
  constructor() {
    super(ED25519, ED25519, 'SHA2-512');
  }
  createKeyPair(): KeyPair {
    return new Ed25519PublicKey();
  }
  generateKeyPair(): Promise<KeyPair> {
    return Promise.reject(new Error('Ed25519 keys are not made here'));
  }
  createSigner(keyPair: KeyPair): Signer {
    if (!(keyPair instanceof AgentKeyPair)) throw new Error('Ed25519 signs with agent keys only');
    return new AgentSigner(keyPair, ED25519);
  }
  createVerifier(keyPair: KeyPair): Verifier {
    if (!(keyPair instanceof Ed25519PublicKey)) throw new Error('not an Ed25519 public key');
    return new Ed25519Verifier(keyPair);
  }
}

/**
 * For `ConnectOptions.configure`: agent keys sign through the agent (RSA, ECDSA), and Ed25519 is
 * added last, so a server is asked for its ECDSA or RSA host key first (the same one each time).
 */
export function agentAlgorithms(config: SshSessionConfiguration): void {
  // Only the library's own RSA and ECDSA (passkeys and the like write their own signature data).
  const wrap = (a: PublicKeyAlgorithm | null): PublicKeyAlgorithm | null =>
    a && !(a instanceof AgentAware) && /^(rsa-sha2-(256|512)|ecdsa-sha2-nistp(256|384|521))$/.test(a.name) ? new AgentAware(a) : a;
  const list = config.publicKeyAlgorithms;
  for (let i = 0; i < list.length; i++) list[i] = wrap(list[i] ?? null);
  if (!config.publicKeyAlgorithms.some((a) => a?.name === ED25519)) config.publicKeyAlgorithms.push(new Ed25519Algorithm());
}

/** The usable keys of the agent at `path` (agentPath()) as key pairs; [] without an agent. */
export async function agentKeys(path: string | undefined): Promise<AgentKeyPair[]> {
  if (!path) return [];
  const agent = new AgentClient(path);
  return (await agent.identities()).map((id) => new AgentKeyPair(agent, id));
}

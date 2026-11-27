/**
 * The client's login: its keys offered one at a time, so that
 * - each key is asked about first (RFC 4252 §7: a request without signature), as OpenSSH's ssh
 *   does: only a key the server would accept signs, so a hardware key, a passkey or an agent that
 *   confirms prompts only when the server knows the key;
 * - a key that can't sign (the agent refused, a hardware key's prompt cancelled, a keystore error)
 *   is skipped: the next key is offered on the same connection (no signature was sent for it);
 * - a server that ends the connection before every key was tried (sshd's MaxAuthTries, 6 by
 *   default) can be asked again, over a new connection, with the keys not tried yet.
 *
 * The library's own queue (one `authenticateClient` call with all the keys) does none of this: it
 * signs each key without asking, a signer that throws ends the session, and the keys left are lost
 * with the connection.
 */

import {
  AuthenticationFailureMessage,
  AuthenticationSuccessMessage,
  KeyPair,
  ObjectDisposedError,
  PublicKeyOKMessage,
  PublicKeyRequestMessage,
  SshClientSession,
  SshConnectionError,
} from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { shownText } from '@md-runbook/core/shownText';
import { certificateOf } from './cert';

/** What one key's offer came to. */
type Offer =
  | { kind: 'ok' }
  | { kind: 'refused' }
  /** The signer threw: no signature was sent for this key (only its query, which the server accepted). */
  | { kind: 'cannot-sign'; message: string }
  /** The connection ended after the key's query or signature was sent (sshd's MaxAuthTries ends it instead of refusing). */
  | { kind: 'closed-sent' }
  /** The connection ended before anything was sent for the key. */
  | { kind: 'closed-unsent' };

/** The server's answer to a query, as the query's promise ends: refused, logged in, or the connection closed. */
class QueryRefused extends Error {}
class QueryLoggedIn extends Error {}
class QueryClosed extends Error {}

type Answer = { kind: 'pk-ok'; blob: Buffer | undefined } | { kind: 'failure' } | { kind: 'success' };

/**
 * The server's answers to this session's login requests, as they come: the methods its last
 * refusal listed (the library reads them only to skip its own queued methods, which one key per
 * call doesn't have), and the answer to a query. The library passes PK_OK (60) by and parses it
 * only where its own requests set the context: registered here, every 60 is PK_OK. A 60 is also
 * keyboard-interactive's INFO_REQUEST, which the client never asks for (it always has keys).
 */
class Answers {
  private methods: string[] | undefined;
  private waiting: { resolve(a: Answer): void; reject(e: Error): void } | undefined;

  constructor(private readonly session: SshClientSession) {
    session.config.messages.set(60, PublicKeyOKMessage);
    const s = session as unknown as { handleMessage(m: unknown, c?: unknown): void | Promise<void> };
    const handle = s.handleMessage.bind(session);
    s.handleMessage = (m, c) => {
      if (m instanceof AuthenticationFailureMessage) {
        this.methods = m.methodNames ?? [];
        this.answer({ kind: 'failure' });
      } else if (m instanceof AuthenticationSuccessMessage) this.answer({ kind: 'success' });
      else if (m instanceof PublicKeyOKMessage) this.answer({ kind: 'pk-ok', blob: m.publicKey });
      // The library's own handling too: a refusal or a success ends its authenticateClient call.
      return handle(m, c);
    };
    session.onClosed(() => this.waiting?.reject(new QueryClosed()));
  }

  /** The methods the server's last refusal listed. */
  listed(): string[] | undefined {
    return this.methods;
  }

  /** Send `query`, then its answer. */
  async ask(query: PublicKeyRequestMessage): Promise<Answer> {
    const answer = new Promise<Answer>((resolve, reject) => (this.waiting = { resolve, reject }));
    // Unawaited when sending fails (that error is the one to throw).
    answer.catch(() => undefined);
    try {
      await this.session.sendMessage(query);
      // A connection that closes now rejects it (QueryClosed).
      return await answer;
    } finally {
      this.waiting = undefined;
    }
  }

  private answer(a: Answer): void {
    const w = this.waiting;
    this.waiting = undefined;
    w?.resolve(a);
  }
}

/**
 * Stands in for a key until the server accepted it: the library asks its `privateKeyProvider`
 * for the key (after the login service request, before signing) when this says it has none.
 */
class Unasked implements KeyPair {
  comment: string | null;
  constructor(private readonly key: KeyPair) {
    this.comment = key.comment;
  }
  get keyAlgorithmName(): string {
    return this.key.keyAlgorithmName;
  }
  get hasPublicKey(): boolean {
    return true;
  }
  get hasPrivateKey(): boolean {
    return false;
  }
  getPublicKeyBytes(algorithmName?: string): Promise<Buffer | null> {
    return this.key.getPublicKeyBytes(algorithmName);
  }
  setPublicKeyBytes(): Promise<void> {
    return Promise.reject(new Error('not supported'));
  }
  generate(): Promise<void> {
    return Promise.reject(new Error('not supported'));
  }
  importParameters(): Promise<void> {
    return Promise.reject(new Error('not supported'));
  }
  exportParameters(): Promise<never> {
    return Promise.reject(new Error('not supported'));
  }
  dispose(): void {}
}

/**
 * Ask the server whether it would accept `key`, with the algorithm and blob the library's signed
 * request sends (a certificate's type and blob): `key` to sign when it would; a Query* error when
 * not, or when the answer ended the login.
 */
async function query(session: SshClientSession, answers: Answers, username: string, key: KeyPair): Promise<KeyPair> {
  // As the library picks the algorithm for the signed request.
  const algorithm = session.config.publicKeyAlgorithms.find((a) => a?.keyAlgorithmName === key.keyAlgorithmName);
  // None configured: the library refuses the key itself (its error says why, as before).
  if (!algorithm) return key;
  const m = new PublicKeyRequestMessage();
  m.serviceName = 'ssh-connection';
  m.username = username;
  m.keyAlgorithmName = algorithm.name;
  m.publicKey = (await key.getPublicKeyBytes(algorithm.name)) ?? undefined;
  const a = await answers.ask(m);
  if (a.kind === 'success') throw new QueryLoggedIn();
  // PK_OK names the key asked about (OpenSSH checks it too).
  if (a.kind === 'pk-ok' && a.blob && m.publicKey && Buffer.from(a.blob).equals(m.publicKey)) return key;
  throw new QueryRefused();
}

/** Offer `key` alone on `session`, which has checked the host key already: asked about first, signed if accepted. */
async function offer(session: SshClientSession, answers: Answers, username: string, key: KeyPair): Promise<Offer> {
  let started!: Promise<void>;
  const answered = new Promise<boolean>((resolve, reject) => {
    // The callback form: its promise settles once the request was sent (or the query or signing
    // threw), the callback when the server answered (or the session closed).
    started = session.authenticateClient(
      { username, publicKeys: [new Unasked(key)], privateKeyProvider: () => query(session, answers, username, key) },
      (err, ok) => (err ? reject(err) : resolve(ok === true)),
    );
  });
  // A signer that throws leaves the answer pending for good; a closed session rejects it.
  answered.catch(() => undefined);
  try {
    await started;
  } catch (e) {
    if (e instanceof QueryRefused) return { kind: 'refused' };
    if (e instanceof QueryLoggedIn) return { kind: 'ok' };
    if (e instanceof QueryClosed) return { kind: 'closed-sent' };
    // The connection's errors, also before the session knows it closed (a failed write): signers
    // don't throw these.
    if (e instanceof ObjectDisposedError || e instanceof SshConnectionError) return { kind: 'closed-unsent' };
    return { kind: 'cannot-sign', message: e instanceof Error ? e.message : String(e) };
  }
  try {
    return (await answered) ? { kind: 'ok' } : { kind: 'refused' };
  } catch {
    return { kind: 'closed-sent' };
  }
}

/** The key's plain public key (a certificate's certified key): a certificate and its key sign with the same private key. */
async function signingKeyId(key: KeyPair): Promise<string> {
  try {
    const blob = (await certificateOf(key))?.publicKey ?? (await key.getPublicKeyBytes());
    return blob ? Buffer.from(blob).toString('base64') : '';
  } catch {
    return '';
  }
}

/** "1 key", "3 keys". */
export function keyCount(n: number): string {
  return n === 1 ? '1 key' : `${n} keys`;
}

/** One login's keys across its connections: which are left to try, and why some couldn't sign. */
export class KeyLogin {
  private next = 0;
  private readonly signErrors: string[] = [];
  /** Keys whose signer threw: their certificate or plain twin is not asked again (a hardware key's prompt). */
  private readonly cannotSign = new Set<string>();

  constructor(
    private readonly keys: readonly KeyPair[],
    private readonly username: string,
  ) {}

  /** Keys not tried yet. */
  get left(): number {
    return this.keys.length - this.next;
  }

  /**
   * Offer the keys not tried yet on `session` (new, its host key checked), in order, until one
   * logs in: 'ok'; every key was tried, or the server takes no more keys: 'refused'; or the
   * connection ended first: 'closed' (`left` says how many keys wait). A key counts as tried once
   * its query or signature was sent, or when its signer threw.
   */
  async run(session: SshClientSession): Promise<'ok' | 'refused' | 'closed'> {
    const answers = new Answers(session);
    while (this.next < this.keys.length) {
      if (session.isClosed) return 'closed';
      const key = this.keys[this.next]!;
      if (this.cannotSign.size > 0) {
        const id = await signingKeyId(key);
        if (id && this.cannotSign.has(id)) {
          this.next++;
          continue;
        }
      }
      const r = await offer(session, answers, this.username, key);
      if (r.kind === 'closed-unsent') return 'closed';
      this.next++;
      if (r.kind === 'ok') return 'ok';
      if (r.kind === 'closed-sent') return 'closed';
      if (r.kind === 'cannot-sign') {
        const id = await signingKeyId(key);
        if (id) this.cannotSign.add(id);
        const text = `a key could not sign: ${shownText(r.message, 200)}`;
        if (!this.signErrors.includes(text)) this.signErrors.push(text);
      }
      // The server takes no more keys (AuthenticationMethods publickey,keyboard-interactive after
      // the first, PubkeyAuthentication no): the keys left can't log in here, nor on a new connection.
      const listed = answers.listed();
      if (r.kind === 'refused' && listed !== undefined && !listed.includes('publickey')) {
        this.next = this.keys.length;
        return 'refused';
      }
    }
    return 'refused';
  }

  /** Why keys couldn't sign, to add to an error. */
  signNotes(): string {
    return this.signErrors.map((n) => `; ${n}`).join('');
  }
}

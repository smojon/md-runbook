/**
 * The client's login: its keys offered one at a time, so that
 * - a key that can't sign (the agent refused, a hardware key's prompt cancelled, a keystore error)
 *   is skipped: the next key is offered on the same connection (nothing was sent for it);
 * - a server that ends the connection before every key was tried (sshd's MaxAuthTries, 6 by
 *   default) can be asked again, over a new connection, with the keys not tried yet.
 *
 * The library's own queue (one `authenticateClient` call with all the keys) does neither: a signer
 * that throws ends the session, and the keys left are lost with the connection.
 */

import { AuthenticationFailureMessage, KeyPair, ObjectDisposedError, SshClientSession, SshConnectionError } from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { shownText } from '@md-runbook/core/shownText';
import { certificateOf } from './cert';

/** What one key's offer came to. */
type Offer =
  | { kind: 'ok' }
  | { kind: 'refused' }
  /** The signer threw: nothing was sent for this key. */
  | { kind: 'cannot-sign'; message: string }
  /** The connection ended after the key's signature was sent (sshd's MaxAuthTries ends it instead of refusing). */
  | { kind: 'closed-sent' }
  /** The connection ended before the key's signature was sent. */
  | { kind: 'closed-unsent' };

/** Offer `key` alone on `session`, which has checked the host key already. */
async function offer(session: SshClientSession, username: string, key: KeyPair): Promise<Offer> {
  let started!: Promise<void>;
  const answered = new Promise<boolean>((resolve, reject) => {
    // The callback form: its promise settles once the request was sent (or signing threw), the
    // callback when the server answered (or the session closed).
    started = session.authenticateClient({ username, publicKeys: [key] }, (err, ok) => (err ? reject(err) : resolve(ok === true)));
  });
  // A signer that throws leaves the answer pending for good; a closed session rejects it.
  answered.catch(() => undefined);
  try {
    await started;
  } catch (e) {
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

/**
 * The methods the server's last refusal listed, as they come: the library reads them only to skip
 * its own queued methods, which one key per call doesn't have.
 */
function watchRefusals(session: SshClientSession): () => string[] | undefined {
  let methods: string[] | undefined;
  const s = session as unknown as { handleMessage(m: unknown, c?: unknown): void | Promise<void> };
  const handle = s.handleMessage.bind(session);
  s.handleMessage = (m, c) => {
    if (m instanceof AuthenticationFailureMessage) methods = m.methodNames ?? [];
    return handle(m, c);
  };
  return () => methods;
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
   * its signature was sent, or when its signer threw.
   */
  async run(session: SshClientSession): Promise<'ok' | 'refused' | 'closed'> {
    const methods = watchRefusals(session);
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
      const r = await offer(session, this.username, key);
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
      const listed = methods();
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

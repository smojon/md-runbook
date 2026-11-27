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

import { KeyPair, ObjectDisposedError, SshClientSession, SshConnectionError } from '@microsoft/dev-tunnels-ssh';
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
    if (session.isClosed && (e instanceof ObjectDisposedError || e instanceof SshConnectionError)) return { kind: 'closed-unsent' };
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
   * Offer the keys not tried yet on `session`, in order, until one logs in: 'ok'; every key was
   * tried: 'refused'; or the connection ended first: 'closed' (`left` says how many keys wait).
   * A key counts as tried once its signature was sent, or when its signer threw.
   */
  async run(session: SshClientSession): Promise<'ok' | 'refused' | 'closed'> {
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
    }
    return 'refused';
  }

  /** What to add to "authentication failed": the keys that couldn't sign, the keys not tried. */
  notes(reconnectError?: string): string {
    const notes = [...this.signErrors];
    if (this.left > 0) {
      const keys = this.left === 1 ? '1 more key was' : `${this.left} more keys were`;
      const why = reconnectError === undefined ? '' : ` (reconnecting failed: ${shownText(reconnectError, 200)})`;
      notes.push(`the server closed the connection before ${keys} tried${why}`);
    }
    return notes.map((n) => `; ${n}`).join('');
  }
}

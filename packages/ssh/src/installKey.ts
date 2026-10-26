/**
 * Install My Key: log in once with the account's password and add the app's public key to its
 * ~/.ssh/authorized_keys (command.ts installKeyCommand), so later logins use the key. The host key
 * is checked first, as for every connection: an untrusted server never sees the password. The
 * password is used for this one login and not kept. POSIX servers (Windows keeps keys elsewhere).
 */

import {
  SshAuthenticatingEventArgs,
  SshAuthenticationType,
  SshClientSession,
  SshDisconnectReason,
  SshSessionConfiguration,
  Stream,
} from '@microsoft/dev-tunnels-ssh';
import { exportPublicKey } from '@microsoft/dev-tunnels-ssh-keys';
import { installKeyCommand } from './command';
import { execRequest, withTimeout } from './remoteShell';

export interface InstallKeyOptions {
  username: string;
  password: string;
  /** The line for authorized_keys (the app's public key). */
  keyLine: string;
  /** As for connections: accept or refuse the server's key line before any credential is sent. */
  verifyHostKey(publicKeyLine: string): boolean | Promise<boolean>;
  timeoutMs?: number;
}

export type InstallKeyResult = 'added' | 'already';

export async function installPublicKey(stream: Stream, opts: InstallKeyOptions): Promise<InstallKeyResult> {
  const session = new SshClientSession(new SshSessionConfiguration());
  session.onAuthenticating((e: SshAuthenticatingEventArgs) => {
    if (e.authenticationType !== SshAuthenticationType.serverPublicKey || !e.publicKey) return;
    const key = e.publicKey;
    e.authenticationPromise = (async () => ((await opts.verifyHostKey(await exportPublicKey(key))) ? {} : null))();
  });
  const closeAll = async (): Promise<void> => {
    await session.close(SshDisconnectReason.byApplication).catch(() => undefined);
    await stream.close().catch(() => undefined);
  };
  const run = async (): Promise<InstallKeyResult> => {
    await session.connect(stream);
    if (!(await session.authenticate({ username: opts.username, password: opts.password }))) {
      throw new Error('the server refused the password (or its host key was not trusted)');
    }
    const channel = await session.openChannel();
    let out = '';
    const decoder = new TextDecoder();
    channel.onDataReceived((data) => {
      out += decoder.decode(data, { stream: true });
      channel.adjustWindow(data.length);
    });
    const closed = new Promise<void>((resolve) => channel.onClosed(() => resolve()));
    if (!(await channel.request(execRequest(installKeyCommand(opts.keyLine))))) throw new Error('the server did not run the command');
    await closed;
    if (out.includes('__MDRB_KEY_ADDED__')) return 'added';
    if (out.includes('__MDRB_KEY_ALREADY__')) return 'already';
    throw new Error('the key could not be added (is this a Linux or macOS server, and its home folder writable?)');
  };
  try {
    return await withTimeout(run(), opts.timeoutMs ?? 30_000, 'installing the key', closeAll);
  } finally {
    await closeAll();
  }
}

# @md-runbook/ssh

Runs md-runbook cells in one persistent shell on a remote host over SSH. It is pure TypeScript
([@microsoft/dev-tunnels-ssh](https://github.com/microsoft/dev-tunnels-ssh)): the same code runs
in Node, in browsers (through the relay) and in React Native. The caller brings the transport;
`@md-runbook/ssh/node` has a TCP one.

```ts
import { RemoteSession, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const key = await generateKey(); // add `await publicKeyLine(key)` to ~/.ssh/authorized_keys
const session = new RemoteSession(() => connectTcp('server', 22), {
  username: 'me',
  key,
  verifyHostKey: (k) => hostKeyId(k) === pinned, // refused before any credential is sent
});
const r = await session.run('cd /srv && ls', { timeoutMs: 60_000, signal, onStdout, onStderr });
```

- **One shell:** the folder and variables carry over from cell to cell, as in a local session.
  `env` values are exported through the channel, never written to the remote disk. `cwd` runs
  one cell in a folder and goes back.
- **Cancel and timeouts** stop the cell's processes (SIGTERM, then SIGKILL) and keep the shell.
  A cell that still runs after that (a loop in the shell itself) closes the shell:
  `shellEnded` in the result.
- **Reconnects:** after the connection or the shell ended, the next cell opens a new shell (same
  host-key check). Its result has `newShell`: the state of earlier cells is gone. Cells are never
  re-run on their own.
- **End-of-cell marker:** `<RS>__MDRB_<id>__ <exit>` on stderr and on stdout. Both, because the
  server reads the two streams separately. With one marker, stderr could still be on its way
  when the cell is reported done.
- **Keys:** P-256 keys made by the library (it can't read OpenSSH's private key format, nor the
  PKCS#8 that macOS's ssh-keygen writes).
- **Agent keys** (Node, `@md-runbook/ssh/node`): `agentKeys(agentPath())` lists an SSH agent's
  Ed25519, ECDSA and RSA keys; pass one as `key` (more in `moreKeys`) with
  `configure: agentAlgorithms`. The agent signs. On Windows the OpenSSH agent's pipe is used.
  - Certificates in the agent are listed too, first.
- **Certificates** (OpenSSH user certificates, `cert.ts`):
  - `CertKeyPair.create(key, certLine)` puts a `…-cert.pub` on a key you have (your own, an
    external one). It refuses a certificate for another key.
  - The login sends the certificate; the key signs. `connect` adds the certificate algorithms
    when a key is one.
  - Ed25519, ECDSA P-256/384/521, and RSA as `rsa-sha2-512-cert-v01@openssh.com` (never SHA-1).
    Not security-key (`sk-`) certificates, nor host certificates.
  - `parseCertificate` reads the key ID, principals, dates, serial and CA fingerprint.
    `certificateState` says valid, expiring, expired or not yet valid. sshd checks the CA.
  - `checkCaSignature` checks the CA's signature with Web Crypto, for what a screen shows.
  - `chooseLoginKeys`: up to 2 certificates within their dates, then the keys tried before (5
    plain agent keys, the own key).
- **Login** (`login.ts`): `key`, then `moreKeys`, one at a time, each once.
  - Each key is queried first (RFC 4252 §7, as OpenSSH's `ssh`). Only a key the server accepts
    signs. A certificate is queried as the certificate.
  - A signer that throws: the key is skipped (no signature was sent), and so is its certificate or
    plain twin. Its message is in the error if no key logs in.
  - `connect(open, opts)` takes a function that opens the transport, as `RemoteSession` passes.
  - The server may end the login with keys left (sshd's `MaxAuthTries`). Then a new connection
    tries them, same host-key check, within `connectTimeoutMs`.
  - At most one connection per key.
  - A reconnect that fails has its own error, without "authentication failed".
  - A refusal that no longer lists `publickey` ends the login: no more keys, no new connection.
  - `connect(stream, opts)`: one connection; the error says how many keys were left.
- Remote shells: bash (login shell, for the user's PATH), else sh. cmd and PowerShell remotes are
  not supported yet.

Tests:
- `test/sshCommand.test.ts`: the shell commands, in a local bash.
- `test/sshAgent.test.ts`: a fake agent.
- `test/sshCert.test.ts`: ssh-keygen's certificates.
- `test/sshKeyRetry.test.ts`: the login's keys, against a server in the test.
- `test/ssh.live.test.ts`: against the OpenSSH server CI starts with `scripts/ci/start-sshd.sh`.

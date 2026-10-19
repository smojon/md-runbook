# @md-runbook/ssh

Runs md-runbook cells in one persistent shell on a remote host over SSH, in pure TypeScript
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
  `env` values are exported through the channel (never written to the remote disk); `cwd` runs
  one cell in a folder and goes back.
- **Cancel and timeouts** stop the cell's processes (SIGTERM, then SIGKILL) and keep the shell.
  A cell that still runs after that (a loop in the shell itself) closes the shell:
  `shellEnded` in the result.
- **Reconnects:** after the connection or the shell ended, the next cell opens a new shell (same
  host-key check) and its result has `newShell`: the state of earlier cells is gone. Cells are
  never re-run on their own.
- **End-of-cell marker:** `<RS>__MDRB_<id>__ <exit>` on stderr and on stdout. Both, because the
  server reads the two streams separately: with one marker, stderr could still be on its way
  when the cell is reported done.
- **Keys:** P-256 keys made by the library (it can't read OpenSSH's private key format, nor the
  PKCS#8 that macOS's ssh-keygen writes).
- Remote shells: bash (login shell, for the user's PATH), else sh. cmd and PowerShell remotes are
  not supported yet.

Tests: `test/sshCommand.test.ts` (the shell commands, in a local bash) and
`test/ssh.live.test.ts` (against the OpenSSH server CI starts with `scripts/ci/start-sshd.sh`).

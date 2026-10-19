/**
 * Spike step A (Node): connect to an SSH server, pin its host key, authenticate with an ECDSA
 * key, and run cells in one persistent shell. Exits 1 if any expectation fails.
 *
 * Environment: SSH_HOST, SSH_PORT, SSH_USER, SSH_KEY_FILE (client private key),
 * SSH_HOST_PUB (the server's host public key file, as in known_hosts).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { NodeStream } from '@microsoft/dev-tunnels-ssh';
import { importKeyFile } from '@microsoft/dev-tunnels-ssh-keys';
import { RemoteShell } from './remoteShell';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};

/** `type base64` of an OpenSSH public key line, without the comment. */
const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(env('SSH_PORT')), env('SSH_HOST'), () => resolve(s));
    s.once('error', reject);
  });
}

async function main(): Promise<void> {
  const key = await importKeyFile(env('SSH_KEY_FILE'));
  const pinned = keyId(fs.readFileSync(env('SSH_HOST_PUB'), 'utf8'));
  let failures = 0;
  const check = (what: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : `\n    ${detail}`}`);
    if (!ok) failures++;
  };

  // A wrong pinned key: the connection is refused before the client key is offered.
  const refused = await RemoteShell.connect(new NodeStream(await connectSocket()), {
    username: env('SSH_USER'),
    key,
    verifyHostKey: () => false,
  }).then(
    () => false,
    () => true,
  );
  check('a host key that does not match the pin is refused', refused);

  let seen = '';
  const t0 = Date.now();
  const shell = await RemoteShell.connect(new NodeStream(await connectSocket()), {
    username: env('SSH_USER'),
    key,
    verifyHostKey: (k) => {
      seen = keyId(k);
      return seen === pinned;
    },
  });
  check(`connected, host key pinned (${seen.slice(0, 40)}…) in ${Date.now() - t0} ms`, seen === pinned);

  const r1 = await shell.run('echo hello from $(hostname)');
  check('stdout and exit code 0', r1.exitCode === 0 && /^hello from /.test(r1.stdout), JSON.stringify(r1));

  await shell.run('cd /tmp && export MDRB_DEMO=kept');
  const r2 = await shell.run('echo "$(pwd) $MDRB_DEMO"');
  check('cd and variables carry over between cells', r2.stdout.trim() === '/tmp kept', JSON.stringify(r2));

  const r3 = await shell.run('echo to-stderr >&2; exit_code() { return 3; }; exit_code');
  check('stderr is separate, non-zero exit code', r3.exitCode === 3 && r3.stderr.trim() === 'to-stderr' && r3.stdout === '', JSON.stringify(r3));

  const tricky = "echo 'single' \"double\" $((1+2))\ncat <<'EOF'\nhere-doc inside a cell\nEOF\necho __MDRB_EOF_fake";
  const r4 = await shell.run(tricky);
  check('quotes, a here-doc and a fake terminator inside the cell', r4.exitCode === 0 && r4.stdout === "single double 3\nhere-doc inside a cell\n__MDRB_EOF_fake\n", JSON.stringify(r4));

  const chunks: string[] = [];
  const r5 = await shell.run('for i in 1 2 3; do echo tick $i; sleep 0.3; done', (_s, t) => chunks.push(t));
  check(`output streams while the cell runs (${chunks.length} chunks)`, r5.exitCode === 0 && chunks.length >= 2, JSON.stringify(chunks));

  const big = await shell.run('seq 1 20000');
  check('20,000 lines of output arrive whole', big.exitCode === 0 && big.stdout.split('\n').length === 20001);

  const t1 = Date.now();
  for (let i = 0; i < 20; i++) await shell.run('true');
  check(`20 empty cells in ${Date.now() - t1} ms (round-trip cost)`, true);

  await shell.close();
  console.log(failures === 0 ? '\n✓ spike A passed' : `\n✗ spike A: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('✗ spike A crashed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});

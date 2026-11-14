/**
 * `exit N` in a cell, against an SSH server in this process (the library's own server side) that
 * plays a shell: it answers the app's hello, shell probe and cells, and ends its channel with
 * the cell's exit status on `exit N`, as OpenSSH does when the shell exits.
 */
import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  KeyPair,
  NodeStream,
  SshAlgorithms,
  SshAuthenticatingEventArgs,
  SshChannel,
  SshExtendedDataType,
  SshServerSession,
  SshSessionConfiguration,
} from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { RemoteSession, RemoteShell, generateKey } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';

const HELLO = /^: mdrb-gate-hello (\w+);[^\n]*\n/;
const PROBE = /^__mdrb_sh=0;[^\n]*__MDRB_(\w+)__[^\n]*\n/;
const CELL = /^__mdrb_f=\$\(mktemp\) && cat > "\$__mdrb_f" <<'__MDRB_EOF_(\w+)'\n([\s\S]*?)__MDRB_EOF_\1\n[\s\S]*?__MDRB_\1__ "\$__mdrb_rc"\n/;

/**
 * A pretend shell on one channel. Cells are lines of `echo TEXT`, `VAR=value`, `echo $VAR`,
 * `false` and `exit N`; state (variables) carries over between cells of the same channel.
 */
function playShell(ch: SshChannel): void {
  let pending = '';
  const vars = new Map<string, string>();
  const out = (s: string): Promise<void> => ch.send(Buffer.from(s, 'utf8'));
  const marker = async (id: string, value: number): Promise<void> => {
    const line = `\x1e__MDRB_${id}__ ${value}\n`;
    await ch.sendExtendedData(SshExtendedDataType.STDERR, Buffer.from(line, 'utf8'));
    await out(line);
  };
  const runCell = async (id: string, body: string): Promise<void> => {
    let rc = 0;
    for (const line of body.split('\n').filter((l) => l !== '')) {
      const exit = /^exit (\d+)$/.exec(line);
      if (exit) {
        await ch.close(Number(exit[1]));
        return;
      }
      const set = /^(\w+)=(.*)$/.exec(line);
      if (set) vars.set(set[1]!, set[2]!);
      else if (line.startsWith('echo ')) await out(line.slice(5).replace(/\$(\w+)/g, (_, n: string) => vars.get(n) ?? '') + '\n');
      rc = line === 'false' ? 1 : 0;
    }
    await marker(id, rc);
  };
  ch.onDataReceived((data) => {
    pending += Buffer.from(data).toString('utf8');
    ch.adjustWindow(data.length);
    void (async () => {
      for (;;) {
        let m: RegExpExecArray | null;
        if ((m = HELLO.exec(pending))) await marker(m[1]!, 4242);
        else if ((m = PROBE.exec(pending))) await marker(m[1]!, 1); // bash
        else if ((m = CELL.exec(pending))) await runCell(m[1]!, m[2]!);
        else return;
        pending = pending.slice(m[0].length);
      }
    })();
  });
}

describe('ssh: `exit N` in a cell', () => {
  let server: net.Server;
  let port = 0;
  let hostKey: KeyPair;
  let key: KeyPair;
  let connections = 0;
  const open = () => connectTcp('127.0.0.1', port);
  const opts = () => ({ username: 'deploy', key, verifyHostKey: () => true, keepAliveSeconds: 0 });

  before(async () => {
    hostKey = await SshAlgorithms.publicKey.ecdsaSha2Nistp256!.generateKeyPair();
    key = await generateKey();
    server = net.createServer((socket) => {
      connections++;
      const session = new SshServerSession(new SshSessionConfiguration());
      session.credentials = { publicKeys: [hostKey] };
      session.onAuthenticating((e: SshAuthenticatingEventArgs) => (e.authenticationPromise = Promise.resolve({})));
      session.onChannelOpening((e) => {
        const ch = e.channel;
        ch.onRequest((r) => {
          if (r.requestType !== 'exec') return;
          r.isAuthorized = true;
          playShell(ch);
        });
      });
      socket.on('error', () => undefined);
      void session.connect(new NodeStream(socket)).catch(() => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());

  it('the cell gets exit code N (not an error), with its output; the shell has ended', async () => {
    const shell = await RemoteShell.connect(await open(), opts());
    try {
      let out = '';
      const r = await shell.run('echo before\nexit 3\necho not-reached', { onStdout: (t) => (out += t) });
      assert.deepEqual([r.exitCode, r.error, r.shellEnded, out], [3, undefined, true, 'before\n']);
      assert.equal(shell.isOpen, false);
    } finally {
      await shell.close();
    }
  });

  it('`exit 1`: exit code 1; the next cell runs in a new shell that works, and keeps its own state', async () => {
    const session = new RemoteSession(open, opts());
    try {
      assert.equal((await session.run('X=old')).exitCode, 0);
      const failed = await session.run('exit 1');
      assert.deepEqual([failed.exitCode, failed.error, failed.shellEnded], [1, undefined, true]);
      const before = connections;
      let out = '';
      const next = await session.run('echo [$X]\nY=new', { onStdout: (t) => (out += t) });
      assert.deepEqual([next.exitCode, next.newShell, out], [0, true, '[]\n']);
      assert.equal(connections, before + 1, 'one new connection');
      out = '';
      const after = await session.run('echo $Y\nfalse', { onStdout: (t) => (out += t) });
      assert.deepEqual([after.exitCode, after.newShell, out], [1, undefined, 'new\n']);
    } finally {
      await session.close();
    }
  });

  it('`exit 0` is a success', async () => {
    const session = new RemoteSession(open, opts());
    try {
      const r = await session.run('exit 0');
      assert.deepEqual([r.exitCode, r.error, r.shellEnded], [0, undefined, true]);
      assert.equal((await session.run('echo ok')).exitCode, 0);
    } finally {
      await session.close();
    }
  });
});

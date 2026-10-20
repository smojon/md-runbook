/**
 * The app's runner against a real OpenSSH server, through the Node transport (the phones use a
 * TCP socket, the web a relay; the SSH code above them is the same). CI starts the server
 * (scripts/ci/start-sshd.sh) and sets MD_RUNBOOK_SSH_TEST=host:port:user, MD_RUNBOOK_SSH_HOST_PUB
 * and MD_RUNBOOK_SSH_AUTHORIZED_KEYS, as for the extension's live test. Skipped without them.
 */
import type { KeyPair, Stream } from '@microsoft/dev-tunnels-ssh';
import { parse } from '@md-runbook/core';
import { RemoteSession, generateKey, hostKeyId, publicKeyLine } from '@md-runbook/ssh';
import type { Host } from '../hosts/store';
import type { Connection } from '../ssh/connections';
import { runCell } from '../ssh/runCell';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const spec = env.MD_RUNBOOK_SSH_TEST;
const [hostname = '', port = '0', username = ''] = (spec ?? '').split(':');
const live = spec ? describe : describe.skip;

const runbook = [
  '# Live',
  '',
  '```bash',
  'cd /tmp; X=kept; echo to-out; echo to-err >&2',
  '```',
  '',
  '```bash',
  'echo "$X $PWD"',
  '```',
  '',
  '```bash',
  'sleep 30; echo not-reached',
  '```',
  '',
].join('\n');
const host: Host = { id: 'live', name: 'live', hostname, port: Number(port), username };

live('runCell against a live OpenSSH server', () => {
  const fs = jest.requireActual<{ appendFileSync(p: string, s: string): void; readFileSync(p: string, e: string): string }>('node:fs');
  const { connectTcp } = jest.requireActual<{ connectTcp(h: string, p: number): Promise<Stream> }>('@md-runbook/ssh/node');
  let key: KeyPair;
  let pinned: string;
  const open: Connection[] = [];

  /** As connections.ts makes them, with `trusted` as the stored host key. */
  const connection = (trusted?: string): Connection => {
    const c: Connection = {
      session: new RemoteSession(() => connectTcp(hostname, Number(port)), {
        username,
        key,
        verifyHostKey: (line) => {
          if (trusted !== undefined && hostKeyId(line) === trusted) return true;
          c.unknownHostKey = line;
          c.changed = trusted !== undefined;
          return false;
        },
      }),
    };
    open.push(c);
    return c;
  };

  beforeAll(async () => {
    key = await generateKey();
    fs.appendFileSync(env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS!, (await publicKeyLine(key)) + '\n');
    pinned = hostKeyId(fs.readFileSync(env.MD_RUNBOOK_SSH_HOST_PUB!, 'utf8'));
  });
  afterAll(async () => {
    await Promise.all(open.map((c) => c.session.close()));
  });

  it('asks for trust on the first contact and when the key changed; nothing runs', async () => {
    const first = await runCell({ host, text: runbook, cellIndex: 1, connection: connection() });
    expect(first).toMatchObject({ kind: 'trust', changed: false });
    expect(first.kind === 'trust' && hostKeyId(first.hostKey)).toBe(pinned);
    const changed = await runCell({ host, text: runbook, cellIndex: 1, connection: connection('ecdsa-sha2-nistp256 AAAAother') });
    expect(changed).toMatchObject({ kind: 'trust', changed: true });
  }, 60_000);

  it('runs cells in one shell, writes the output blocks, and stops a cell on request', async () => {
    const c = connection(pinned);
    const a = await runCell({ host, text: runbook, cellIndex: 1, connection: c });
    expect(a.kind).toBe('done');
    if (a.kind !== 'done') return;
    expect(a.attrs.exit).toBe('0');
    expect(parse(a.text).cells[1]?.output?.text).toBe('to-out\nto-err');

    const b = await runCell({ host, text: a.text, cellIndex: 2, connection: c });
    expect(b.kind).toBe('done');
    if (b.kind !== 'done') return;
    expect(parse(b.text).cells[2]?.output?.text).toMatch(/^kept (\/private)?\/tmp$/);
    expect(parse(b.text).cells[1]?.output?.text).toBe('to-out\nto-err');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const started = Date.now();
    const stopped = await runCell({ host, text: b.text, cellIndex: 3, connection: c, signal: ac.signal });
    expect(stopped.kind === 'done' && stopped.attrs.exit).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(c.session.isConnected).toBe(true);
  }, 60_000);
});

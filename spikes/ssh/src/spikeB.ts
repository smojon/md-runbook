/**
 * Spike step B (browser): the same RemoteShell, over a WebSocket to the relay. The test driver
 * (spikeB-driver.ts) opens this page in headless Chrome with the settings in the URL hash and
 * reads `window.__result`.
 */

import { WebSocketStream } from '@microsoft/dev-tunnels-ssh';
import { importKey } from '@microsoft/dev-tunnels-ssh-keys';
import { RemoteShell } from './remoteShell';

interface Settings {
  relay: string;
  token: string;
  target: string;
  user: string;
  keyPem: string;
  pinned: string;
}

declare global {
  interface Window {
    __result?: { ok: boolean; lines: string[] };
  }
}

const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

function openSocket(s: Settings, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${s.relay}?target=${encodeURIComponent(s.target)}`, ['mdrb-relay', `token.${token}`]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('websocket refused'));
  });
}

async function main(): Promise<void> {
  const s = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Settings;
  const lines: string[] = [];
  let ok = true;
  const check = (what: string, pass: boolean, detail = ''): void => {
    lines.push(`${pass ? '✓' : '✗'} ${what}${pass || !detail ? '' : ` — ${detail}`}`);
    ok &&= pass;
  };

  check('the relay refuses a wrong token', await openSocket(s, 'wrong-token-0123456789').then(() => false, () => true));

  const key = await importKey(s.keyPem);
  const t0 = performance.now();
  let seen = '';
  const shell = await RemoteShell.connect(new WebSocketStream(await openSocket(s, s.token)), {
    username: s.user,
    key,
    verifyHostKey: (k) => {
      seen = keyId(k);
      return seen === s.pinned;
    },
  });
  check(`connected through the relay, host key pinned, in ${Math.round(performance.now() - t0)} ms (Web Crypto: ${typeof crypto.subtle})`, seen === s.pinned);

  const r1 = await shell.run('echo hello from the browser; uname -s');
  check('a cell runs, exit code 0', r1.exitCode === 0 && r1.stdout.startsWith('hello from the browser'), JSON.stringify(r1));
  await shell.run('cd /tmp');
  const r2 = await shell.run('pwd; echo err >&2; false');
  check('state carries over, stderr and exit code', r2.stdout.trim() === '/tmp' && r2.stderr.trim() === 'err' && r2.exitCode === 1, JSON.stringify(r2));
  await shell.close();
  window.__result = { ok, lines };
}

main().catch((e: unknown) => {
  window.__result = { ok: false, lines: [`✗ crashed: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`] };
});

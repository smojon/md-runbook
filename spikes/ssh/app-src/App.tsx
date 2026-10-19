/**
 * Spike step C (React Native): the same RemoteShell on a phone, over a TCP socket. On launch it
 * runs a few cells against the SSH server in spike-config.json (written by CI) and logs
 * `SPIKE-C …` lines, which CI reads from the device log. The screen shows the same lines.
 */

import { install } from 'react-native-quick-crypto';
install(); // Node-style crypto (and Buffer) for the SSH library
import { Buffer } from 'buffer';
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

import { importKey } from '@microsoft/dev-tunnels-ssh-keys';
import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import { RemoteShell } from './src/remoteShell';
import { TcpSocketStream } from './src/tcpStream';
import config from './spike-config.json';

const keyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

async function runSpike(log: (line: string) => void): Promise<boolean> {
  let ok = true;
  const check = (what: string, pass: boolean, detail = ''): void => {
    log(`${pass ? '✓' : '✗'} ${what}${pass || !detail ? '' : ` — ${detail}`}`);
    ok &&= pass;
  };
  const host = Platform.OS === 'android' ? config.androidHost : config.host;
  log(`platform ${Platform.OS} ${String(Platform.Version)}, server ${host}:${config.port}, Web Crypto: ${typeof globalThis.crypto?.subtle}`);
  const t0 = Date.now();
  const key = await importKey(config.keyPem);
  log(`key imported in ${Date.now() - t0} ms`);
  let seen = '';
  const t1 = Date.now();
  const shell = await RemoteShell.connect(await TcpSocketStream.connect(host, config.port), {
    username: config.user,
    key,
    verifyHostKey: (k) => {
      seen = keyId(k);
      return seen === keyId(config.hostPub);
    },
  });
  check(`connected, host key pinned, in ${Date.now() - t1} ms`, seen === keyId(config.hostPub));
  const r1 = await shell.run(`echo hello from ${Platform.OS}`);
  check('a cell runs, exit code 0', r1.exitCode === 0 && r1.stdout.trim() === `hello from ${Platform.OS}`, JSON.stringify(r1));
  await shell.run('cd /tmp && export MDRB_DEMO=kept');
  const r2 = await shell.run('echo "$(pwd) $MDRB_DEMO"; echo err >&2; false');
  check('state carries over, stderr and exit code', r2.stdout.trim() === '/tmp kept' && r2.stderr.trim() === 'err' && r2.exitCode === 1, JSON.stringify(r2));
  const t2 = Date.now();
  for (let i = 0; i < 10; i++) await shell.run('true');
  check(`10 empty cells in ${Date.now() - t2} ms`, true);
  await shell.close();
  return ok;
}

export default function App(): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const log = (line: string): void => {
      console.log(`SPIKE-C ${line}`);
      setLines((l) => [...l, line]);
    };
    runSpike(log).then(
      (ok) => log(ok ? 'PASSED' : 'FAILED'),
      (e: unknown) => log(`CRASHED ${e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e)}`),
    );
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }}>
      <Text style={{ fontWeight: 'bold', marginBottom: 12 }}>md-runbook SSH spike</Text>
      {lines.map((l, i) => (
        <Text key={i} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 }}>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}

/** Test helpers: real ssh-keygen keys and signatures, a server on a free port, requests. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { ManifestMeta, buildManifest, formatManifest, withSignature } from '../../../packages/core/src/signing';
import { sshSign } from '../../../packages/core/src/node/sign';
import type { ServerConfig, Token } from '../src/config';
import type { LogEvent } from '../src/http';
import { LibraryServer, ServerOptions, createLibraryServer } from '../src/server';

export const UPLOAD = 'upload-token-of-at-least-24-chars';
export const tok = (value: string, label = 'test'): Token => ({ label, value });

export const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
export const RUNBOOK = '# Restart the API\n\nRestart it when it hangs.\n\n' + fence('bash', 'systemctl restart api');

export interface Keys {
  dir: string;
  signer: string;
  stranger: string;
  runner: string;
  allowedSigners: string;
  allowedRunners: string;
}

/** A folder with three keys (a signer, a stranger, a runner) and the files that trust them. */
export function makeKeys(): Keys {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-libsrv-'));
  const key = (name: string, comment: string): string => {
    const f = path.join(dir, name);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', f]);
    return f;
  };
  const signer = key('signer', 'ops@example.net');
  const stranger = key('stranger', 'stranger@example.net');
  const runner = key('runner', 'ana@example.net');
  const pub = (f: string): string => fs.readFileSync(f + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const allowedSigners = path.join(dir, 'allowed_signers');
  fs.writeFileSync(allowedSigners, `ops@example.net namespaces="md-runbook" ${pub(signer)}\n`);
  const allowedRunners = path.join(dir, 'allowed_runners');
  fs.writeFileSync(allowedRunners, `ana@example.net namespaces="md-runbook-run" ${pub(runner)}\n`);
  return { dir, signer, stranger, runner, allowedSigners, allowedRunners };
}

/** `text` signed with `key` (manifest version 2 unless `version: 1`). */
export async function signRunbook(text: string, meta: Partial<ManifestMeta>, key: string, version: 1 | 2 = 2): Promise<string> {
  const built = buildManifest(text, { name: 'ops/restart-api', version: 1, scopes: [], patterns: {}, ...meta }, { version });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);
  const signature = await sshSign(manifest, key, { interactive: false });
  return withSignature(text, { signer: 'ops@example.net', signed: '2026-11-14', manifest, signature });
}

export function config(dir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    stateDir: path.join(dir, 'state'),
    origins: [],
    trustProxy: false,
    ratePerMinute: 1000,
    maxFailures: 50,
    failWindowMs: 60_000,
    sshKeygen: 'ssh-keygen',
    ...over,
  };
}

export async function start(cfg: ServerConfig, opts: ServerOptions = {}): Promise<{ s: LibraryServer; url: string; logs: LogEvent[] }> {
  const logs: LogEvent[] = [];
  const s = createLibraryServer(cfg, '9.9.9', { log: (e) => logs.push(e), ...opts });
  await new Promise<void>((r) => s.server.listen(0, '127.0.0.1', () => r()));
  return { s, url: `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`, logs };
}

export async function call(url: string, method: string, body?: string, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method, ...(body !== undefined ? { body } : {}), headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

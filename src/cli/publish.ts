/**
 * `md-runbook publish <file.md> --library URL [--path PATH]`: send a signed runbook to a team
 * library (apps/library-server), which checks it and writes it into the folder the web app serves.
 * The upload token comes from the environment only (MD_RUNBOOK_LIBRARY_TOKEN): on a command line
 * other users of the machine could read it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { reportAddressProblem } from '@md-runbook/core/secrets';
import { readSignature } from '@md-runbook/core/signing';

export const PUBLISH_USAGE = `Usage: md-runbook publish <file.md> --library URL [--path PATH]

Publishes a signed runbook to a team library (the library server, apps/library-server):
POST URL/v1/library/runbooks/PATH. The server takes it only when the whole runbook is signed by
one of the library's signers, unchanged since signing, not expired, named as its file, and of a
higher version than the one published at PATH.

Options:
  --library URL   The library server's address, e.g. https://runbooks.example.net
  --path PATH     Where in the library (default: the file's name), e.g. ops/restart-api.md

The upload token is read from MD_RUNBOOK_LIBRARY_TOKEN, never from the command line.

Exit code: 0 published (or the same text was there already), 1 refused, 2 a usage error, or no
usable answer from the server (unreachable, not a library server, too many requests).
`;

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export async function publishCommand(
  argv: readonly string[],
  out: (line: string) => void = (l) => void process.stdout.write(l + '\n'),
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<number> {
  const args = [...argv];
  let file: string | undefined;
  let library: string | undefined;
  let target: string | undefined;
  const usage = (why: string): number => {
    process.stderr.write(`md-runbook: ${why}\n\n${PUBLISH_USAGE}`);
    return 2;
  };
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === '-h' || a === '--help') return void process.stdout.write(PUBLISH_USAGE), 0;
    if (a === '--library') library = args.shift();
    else if (a === '--path') target = args.shift();
    else if (a.startsWith('-')) return usage(`unknown option ${a}`);
    else if (file) return usage('one runbook at a time');
    else file = a;
  }
  if (!file) return usage('missing the runbook file');
  if (!library) return usage('--library needs the library server\'s address');
  const base = library.replace(/\/+$/, '');
  const why = reportAddressProblem(base);
  if (why) return usage(`--library ${library}: ${why}`);
  const token = env.MD_RUNBOOK_LIBRARY_TOKEN;
  if (!token) return usage('set MD_RUNBOOK_LIBRARY_TOKEN to the library\'s upload token');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`md-runbook: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  // The server would say the same; this saves sending a runbook that can't go in.
  if (!readSignature(text)) {
    out(`✗ ${file} is not signed: a library takes signed runbooks only (md-runbook sign ${file} --key KEY)`);
    return 1;
  }
  const where = (target ?? path.basename(file)).replace(/\\/g, '/').replace(/^\/+/, '');
  const url = `${base}/v1/library/runbooks/${where.split('/').map(encodeURIComponent).join('/')}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  let status: number;
  let body: string;
  try {
    const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'text/markdown; charset=utf-8', authorization: `Bearer ${token}` }, body: text, redirect: 'error', signal: abort.signal });
    status = r.status;
    body = await r.text();
  } catch (e) {
    process.stderr.write(`md-runbook: ${base} did not answer: ${abort.signal.aborted ? 'no answer in 30 s' : e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  } finally {
    clearTimeout(timer);
  }
  let answer: { name?: string; version?: number; previous?: number; signer?: string; unchanged?: boolean; error?: string; problems?: string[] } = {};
  try {
    answer = JSON.parse(body);
  } catch {
    answer = { error: body.slice(0, 200) };
  }
  if (status === 200 || status === 201) {
    out(
      answer.unchanged
        ? `✓ ${where}: ${answer.name} version ${answer.version} is published already (the same text)`
        : `✓ published ${answer.name} version ${answer.version} at ${where}${answer.previous ? ` (was version ${answer.previous})` : ''}, signed by ${answer.signer}`,
    );
    return 0;
  }
  out(`✗ ${where}: the library refused it (HTTP ${status}): ${answer.error ?? 'no reason given'}`);
  for (const p of answer.problems ?? []) out(`  ${p}`);
  return status === 401 || status === 403 || status === 409 || status === 413 || status === 422 || status === 400 ? 1 : 2;
}

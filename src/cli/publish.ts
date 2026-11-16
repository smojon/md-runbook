/**
 * `md-runbook publish <file.md> --library URL [--path PATH]`: send a signed runbook to a team
 * library (apps/library-server), which checks it and writes it into the folder the web app serves.
 * `md-runbook unpublish <PATH> --library URL`: remove one (where the server allows it).
 * The upload token comes from the environment only (MD_RUNBOOK_LIBRARY_TOKEN): on a command line
 * other users of the machine could read it. The requests are libraryClient.ts's, as VS Code's.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { libraryPathProblem } from '@md-runbook/core/library';
import { readSignature } from '@md-runbook/core/signing';
import { LIBRARY_TOKEN_ENV, LibraryFetch, cleanLibraryPath, libraryServerAddress, publishedText, refusedStatus, removeRefusal, sendToLibrary } from '../libraryClient';

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

export const UNPUBLISH_USAGE = `Usage: md-runbook unpublish <PATH> --library URL

Removes the runbook at PATH from a team library (the library server, apps/library-server):
DELETE URL/v1/library/runbooks/PATH. Only where the server allows it (LIBRARY_ALLOW_DELETE).
The server keeps the highest version published there: an older one can't come back.

Options:
  --library URL   The library server's address, e.g. https://runbooks.example.net

The upload token is read from MD_RUNBOOK_LIBRARY_TOKEN, never from the command line.

Exit code: 0 removed, 1 refused (not there, removing is off, the token refused), 2 a usage
error, or no usable answer from the server.
`;

const write = (l: string): void => void process.stdout.write(l + '\n');

/** The options both commands share: one positional argument, --library, and (publish) --path. */
function parseLibraryArgs(argv: readonly string[], withPath: boolean): { help: true } | { error: string } | { arg?: string; library?: string; target?: string } {
  const args = [...argv];
  let arg: string | undefined;
  let library: string | undefined;
  let target: string | undefined;
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--library') library = args.shift();
    else if (withPath && a === '--path') target = args.shift();
    else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (arg) return { error: 'one runbook at a time' };
    else arg = a;
  }
  return { ...(arg !== undefined ? { arg } : {}), ...(library !== undefined ? { library } : {}), ...(target !== undefined ? { target } : {}) };
}

export async function publishCommand(
  argv: readonly string[],
  out: (line: string) => void = write,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: LibraryFetch,
): Promise<number> {
  const usage = (why: string): number => {
    process.stderr.write(`md-runbook: ${why}\n\n${PUBLISH_USAGE}`);
    return 2;
  };
  const parsed = parseLibraryArgs(argv, true);
  if ('help' in parsed) return void process.stdout.write(PUBLISH_USAGE), 0;
  if ('error' in parsed) return usage(parsed.error);
  const { arg: file, library, target } = parsed;
  if (!file) return usage('missing the runbook file');
  if (!library) return usage('--library needs the library server\'s address');
  const server = libraryServerAddress(library);
  if ('problem' in server) return usage(`--library ${library}: ${server.problem}`);
  const token = env[LIBRARY_TOKEN_ENV];
  if (!token) return usage(`set ${LIBRARY_TOKEN_ENV} to the library's upload token`);
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
  const where = cleanLibraryPath(target ?? path.basename(file));
  const r = await sendToLibrary({ method: 'POST', server: server.base, path: where, token, text, ...(fetchFn ? { fetchFn } : {}) });
  if (r.kind === 'unreachable') {
    process.stderr.write(`md-runbook: ${server.base} did not answer: ${r.why}\n`);
    return 2;
  }
  if (r.status === 200 || r.status === 201) {
    out(`✓ ${publishedText(where, r.answer)}`);
    return 0;
  }
  out(`✗ ${where}: the library refused it (HTTP ${r.status}): ${r.answer.error ?? 'no reason given'}`);
  for (const p of r.answer.problems ?? []) out(`  ${p}`);
  return refusedStatus(r.status) && r.status !== 404 && r.status !== 405 ? 1 : 2;
}

export async function unpublishCommand(
  argv: readonly string[],
  out: (line: string) => void = write,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: LibraryFetch,
): Promise<number> {
  const usage = (why: string): number => {
    process.stderr.write(`md-runbook: ${why}\n\n${UNPUBLISH_USAGE}`);
    return 2;
  };
  const parsed = parseLibraryArgs(argv, false);
  if ('help' in parsed) return void process.stdout.write(UNPUBLISH_USAGE), 0;
  if ('error' in parsed) return usage(parsed.error);
  const { arg, library } = parsed;
  if (!arg) return usage('missing the runbook\'s path in the library, e.g. ops/restart-api.md');
  const where = cleanLibraryPath(arg);
  const bad = libraryPathProblem(where);
  if (bad) return usage(`${arg}: ${bad}`);
  if (!library) return usage('--library needs the library server\'s address');
  const server = libraryServerAddress(library);
  if ('problem' in server) return usage(`--library ${library}: ${server.problem}`);
  const token = env[LIBRARY_TOKEN_ENV];
  if (!token) return usage(`set ${LIBRARY_TOKEN_ENV} to the library's upload token`);
  const r = await sendToLibrary({ method: 'DELETE', server: server.base, path: where, token, ...(fetchFn ? { fetchFn } : {}) });
  if (r.kind === 'unreachable') {
    process.stderr.write(`md-runbook: ${server.base} did not answer: ${r.why}\n`);
    return 2;
  }
  if (r.status === 200) {
    out(`✓ removed ${r.answer.deleted ?? where}${r.answer.version ? ` (version ${r.answer.version})` : ''} from the library`);
    return 0;
  }
  out(`✗ ${where}: ${removeRefusal(where, r.status, r.answer)}`);
  return refusedStatus(r.status) ? 1 : 2;
}

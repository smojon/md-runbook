/**
 * `md-runbook sign` and `md-runbook verify`: release a runbook for servers that run md-runbook-gate,
 * and check one (docs/features/signed-runbooks.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { locateCodeCells, parse } from '@md-runbook/core';
import { checkSignedSteps, keyComment, manifestHash, nodeShellEnv, resolveShell, sshSign, sshVerify } from '@md-runbook/core/node';
import { ManifestMeta, buildManifest, formatManifest, parseManifest, readSignature, signedStatus, withSignature } from '@md-runbook/core/signing';

export const SIGN_USAGE = `Usage: md-runbook sign <file.md> --key KEY [options]
       md-runbook verify <file.md> [--allowed-signers FILE]

sign writes a signature block at the end of the runbook: its bash blocks as servers with
md-runbook-gate run them, signed with ssh-keygen. Signing again keeps the name, scopes and
patterns and counts the version up.

  --key KEY            Private key, or a .pub whose key is in the SSH agent (ssh-keygen -Y sign)
  --signer NAME        Name shown as the signer (default: the key's comment)
  --name NAME          Runbook name, e.g. ops/restart-api (default: the file name)
  --version N          Version (default: the previous one + 1, else 1)
  --expires DATE       Last day it may run, YYYY-MM-DD (UTC)
  --expires-in DAYS    The same, counted from today
  --scope NAME         Where it may run (repeatable; servers and keys accept scopes)
  --pattern NAME=RE    What \${param:NAME}, \${input:NAME} or \${out:NAME} may be: a POSIX
                       extended regex for the whole value
  --out FILE           Write the signed runbook to FILE instead

verify shows what a runbook's signature covers and which blocks changed since signing. Only
with --allowed-signers (a server's allowed_signers file) does it check the signature as the gate
would; without it, the signer's name is just what the file says. Exit code 0 when everything is
signed (and, with --allowed-signers, the signature verifies).
`;

class SignUsageError extends Error {}

const today = (offsetDays = 0): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function defaultName(file: string): string {
  const base = path.basename(file).replace(/(\.runbook)?\.md$/i, '');
  return base.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'runbook';
}

interface SignArgs {
  file: string;
  key: string;
  signer?: string;
  name?: string;
  version?: number;
  expires?: string;
  scopes?: string[];
  patterns: Record<string, string>;
  out?: string;
}

export function parseSignArgs(argv: readonly string[]): SignArgs {
  const args = [...argv];
  const a: Partial<SignArgs> & { patterns: Record<string, string> } = { patterns: {} };
  const value = (flag: string): string => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new SignUsageError(`${flag} needs a value`);
    return v;
  };
  while (args.length > 0) {
    const f = args.shift()!;
    switch (f) {
      case '--key': a.key = value(f); break;
      case '--signer': a.signer = value(f); break;
      case '--name': a.name = value(f); break;
      case '--out': a.out = value(f); break;
      case '--version': {
        const n = Number(value(f));
        if (!Number.isInteger(n) || n < 1) throw new SignUsageError('--version expects a positive whole number');
        a.version = n;
        break;
      }
      case '--expires': a.expires = value(f); break;
      case '--expires-in': {
        const d = Number(value(f));
        if (!Number.isInteger(d) || d < 0) throw new SignUsageError('--expires-in expects days');
        a.expires = today(d);
        break;
      }
      case '--scope': (a.scopes ??= []).push(value(f)); break;
      case '--pattern': {
        const v = value(f);
        const eq = v.indexOf('=');
        if (eq <= 0) throw new SignUsageError(`--pattern expects NAME=REGEX, got "${v}"`);
        a.patterns[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      default:
        if (f.startsWith('-')) throw new SignUsageError(`unknown option ${f}`);
        if (a.file) throw new SignUsageError(`one runbook at a time (got "${a.file}" and "${f}")`);
        a.file = f;
    }
  }
  if (!a.file) throw new SignUsageError('missing the runbook file');
  if (!a.key) throw new SignUsageError('missing --key');
  return a as SignArgs;
}

type Out = (line: string) => void;
const stdout: Out = (l) => void process.stdout.write(l + '\n');

/** `md-runbook sign`: 0 when signed, 1 when the runbook can't be signed, 2 for a usage error. */
export async function signCommand(argv: readonly string[], out: Out = stdout, sshKeygen?: string): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) return void process.stdout.write(SIGN_USAGE), 0;
  let a: SignArgs;
  try {
    a = parseSignArgs(argv);
  } catch (e) {
    if (!(e instanceof SignUsageError)) throw e;
    process.stderr.write(`md-runbook: ${e.message}\n\n${SIGN_USAGE}`);
    return 2;
  }
  if (!fs.existsSync(a.file)) {
    process.stderr.write(`md-runbook: no such file: ${a.file}\n`);
    return 2;
  }
  const text = fs.readFileSync(a.file, 'utf8');
  // Signing again: the previous signature's metadata, unless given now.
  const prev = (() => {
    const b = readSignature(text);
    try {
      return b ? { block: b, manifest: parseManifest(b.manifest) } : undefined;
    } catch {
      return undefined;
    }
  })();
  const meta: ManifestMeta = {
    name: a.name ?? prev?.manifest.name ?? defaultName(a.file),
    version: a.version ?? (prev ? prev.manifest.version + 1 : 1),
    ...(a.expires ? { expires: a.expires } : {}),
    scopes: a.scopes ?? prev?.manifest.scopes ?? [],
    patterns: { ...(prev?.manifest.patterns ?? {}), ...a.patterns },
  };
  const built = buildManifest(text, meta);
  if ('errors' in built) {
    for (const e of built.errors) out(`${a.file}: error: ${e}`);
    out(`✗ not signed`);
    return 1;
  }
  const bash = resolveShell('bash', {}, nodeShellEnv());
  const stepProblems = bash.ok ? await checkSignedSteps(built.manifest, bash.shell.command) : undefined;
  if (stepProblems?.length) {
    for (const p of stepProblems) out(`${a.file}: error: ${p}`);
    out('✗ not signed: a server runs these commands one by one; make each a whole command (or end the cell differently)');
    return 1;
  }
  if (!stepProblems) out('  note: bash not found, so the commands were not checked one by one (bash -n)');
  const manifest = formatManifest(built.manifest);
  let signature: string;
  try {
    signature = await sshSign(manifest, a.key, { sshKeygen });
  } catch (e) {
    out(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const signer = a.signer ?? keyComment(a.key) ?? prev?.block.signer ?? 'unknown';
  const target = a.out ?? a.file;
  fs.writeFileSync(target, withSignature(text, { signer, signed: today(), manifest, signature }), 'utf8');
  const m = built.manifest;
  out(
    `✓ ${m.name} version ${m.version} signed by ${signer}: ${m.cells.length} block${m.cells.length === 1 ? '' : 's'}` +
      `${m.scopes.length ? `, scopes ${m.scopes.join(' ')}` : ''}${m.expires ? `, until ${m.expires}` : ''} · written to ${target}`,
  );
  out(`  manifest sha256 ${manifestHash(manifest)} (list it in a server's revoked file to withdraw this version)`);
  return 0;
}

/** `md-runbook verify`: 0 when every block is signed (and, with --allowed-signers, the signature verifies). */
export async function verifyCommand(argv: readonly string[], out: Out = stdout, sshKeygen?: string): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) return void process.stdout.write(SIGN_USAGE), 0;
  const args = [...argv];
  let file: string | undefined;
  let allowed: string | undefined;
  while (args.length > 0) {
    const f = args.shift()!;
    if (f === '--allowed-signers') allowed = args.shift();
    else if (f.startsWith('-') || file) {
      process.stderr.write(`md-runbook: ${f.startsWith('-') ? `unknown option ${f}` : 'one runbook at a time'}\n\n${SIGN_USAGE}`);
      return 2;
    } else file = f;
  }
  if (!file || (argv.includes('--allowed-signers') && !allowed)) {
    process.stderr.write(`md-runbook: ${file ? '--allowed-signers needs a file' : 'missing the runbook file'}\n\n${SIGN_USAGE}`);
    return 2;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`md-runbook: no such file: ${file}\n`);
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  const status = signedStatus(text);
  if (!status) {
    out(`✗ ${file}: ${/<!-- md-runbook:signature/.test(text) ? 'the signature block is damaged' : 'not signed'}`);
    return 1;
  }
  const m = status.manifest;
  // The signer's name and date are what the file says; only the key check below proves who signed.
  out(`${file}: ${m.name} version ${m.version}, signed by ${status.block.signer} (as the file says) on ${status.block.signed}`);
  out(`  scopes: ${m.scopes.length ? m.scopes.join(' ') : 'none (only servers that accept any scope)'}`);
  if (m.expires) out(`  expires: ${m.expires}${m.expires < today() ? ' (expired)' : ''}`);
  for (const [name, re] of Object.entries(m.patterns)) out(`  parameter ${name}: ${re}`);
  out(`  manifest sha256 ${manifestHash(status.block.manifest)}`);
  let ok = true;
  const lines = new Map(locateCodeCells(parse(text)).map((l) => [l.cellIndex, l.line]));
  for (const i of status.changed) {
    out(`${file}:${(lines.get(i) ?? 0) + 1}: changed since signing: servers that only run signed runbooks refuse this block`);
    ok = false;
  }
  for (const i of status.moved) {
    out(`${file}:${(lines.get(i) ?? 0) + 1}: moved since signing: signed as block ${status.cells.get(i)!.n}, after blocks that now come later`);
    ok = false;
  }
  if (status.missing.length > 0) {
    out(`  signed block${status.missing.length === 1 ? '' : 's'} ${status.missing.join(', ')} of ${m.cells.length} not in the file as signed (deleted or changed)`);
    ok = false;
  }
  if (m.expires && m.expires < today()) ok = false;
  if (allowed) {
    try {
      out(`  signature: good, by ${await sshVerify(status.block.manifest, status.block.signature, allowed, sshKeygen)} (${allowed})`);
    } catch (e) {
      out(`  signature: ${e instanceof Error ? e.message : String(e)}`);
      ok = false;
    }
  } else {
    out('  signature: NOT checked (anyone can write a signer name): add --allowed-signers FILE to check it as the gate does');
  }
  out(
    `${ok ? '✓' : '✗'} ${status.cells.size} signed block${status.cells.size === 1 ? '' : 's'}, ${status.changed.length} changed` +
      (allowed ? '' : ', signature not checked'),
  );
  return ok ? 0 : 1;
}

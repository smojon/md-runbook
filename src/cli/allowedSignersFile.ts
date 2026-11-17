/**
 * `--allowed-signers FILE` on the command line: ssh-keygen gets the filtered copy
 * (../filteredSigners.ts), so a line md-runbook can't read as OpenSSH does (an escape, a stray
 * quote) never counts. Each such line is named once on stderr. Lines for other namespaces only are
 * left out without a word: they never count for a runbook. Messages name the file given, not the copy.
 */

import { sshVerify, trustedRunbookSigner } from '@md-runbook/core/node';
import { filteredSigners } from '../filteredSigners';

const warned = new Set<string>();

/** The copy to give ssh-keygen; the lines left out are said once per file (`warn`, default stderr). */
export function cliSignersFile(file: string, warn: (line: string) => void = (l) => void process.stderr.write(l + '\n')): string {
  const got = filteredSigners(file);
  if (!warned.has(file)) {
    warned.add(file);
    for (const r of got.refused)
      if (!/^for other namespaces/.test(r.problem)) warn(`md-runbook: ${file} line ${r.line + 1} not used: ${r.problem.replace(/: not used$/, '')}`);
  }
  return got.file;
}

const named = (e: unknown, copy: string, file: string): Error => new Error((e instanceof Error ? e.message : String(e)).split(copy).join(file));

/** sshVerify against the filtered copy of `file`: the principal, or why not (naming `file`). */
export async function cliSshVerify(manifest: string, signature: string, file: string, sshKeygen?: string, warn?: (line: string) => void): Promise<string> {
  const copy = cliSignersFile(file, warn);
  try {
    return await sshVerify(manifest, signature, copy, sshKeygen);
  } catch (e) {
    throw named(e, copy, file);
  }
}

/** trustedRunbookSigner against the filtered copy of `file`. */
export const cliTrustedRunbookSigner = (text: string, file: string, warn?: (line: string) => void): Promise<string | undefined> =>
  trustedRunbookSigner(text, cliSignersFile(file, warn));

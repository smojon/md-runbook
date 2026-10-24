/**
 * Sign Runbook and Co-sign Runbook, as in the extension (src/signing.ts there): the manifest is
 * built by the core, signed with this app's key (SSHSIG, which md-runbook-gate checks with
 * ssh-keygen against its allowed_signers), and the signature block goes into the runbook's text.
 * The phone's key signs inside its secure hardware.
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { parse, shellKindForLanguage } from '@md-runbook/core';
import { findRefs } from '@md-runbook/core/secrets';
import {
  Manifest,
  ManifestMeta,
  RUNBOOK_NAME_RE,
  SCOPE_RE,
  SignatureBlock,
  buildManifest,
  cosignable,
  formatManifest,
  parseManifest,
  readSignature,
  signerLabel,
  withSignature,
} from '@md-runbook/core/signing';
import { signSshsig } from '@md-runbook/ssh';

/** A `${param:}`, `${input:}` or `${out:}` a signed cell uses: servers check its value against a pattern. */
export interface PatternNeed {
  name: string;
  kind: 'param' | 'input' | 'out';
}

/** What signing this runbook asks for: on a first signing a name and scopes, then the patterns still missing. */
export interface SignPlan {
  /** The signed manifest this one follows (its version is counted up; name and scopes are kept). */
  previous?: Manifest;
  /** The default name: the file's name without `.md`. */
  name: string;
  version: number;
  needs: PatternNeed[];
}

export function signPlan(text: string, fileName: string | undefined): SignPlan {
  const block = readSignature(text);
  let previous: Manifest | undefined;
  try {
    previous = block ? parseManifest(block.manifest) : undefined;
  } catch {
    previous = undefined;
  }
  const seen = new Map<string, PatternNeed['kind']>();
  for (const cell of parse(text).cells) {
    if (cell.kind !== 'code' || shellKindForLanguage(cell.languageId) !== 'bash') continue;
    try {
      for (const r of findRefs(cell.value)) if (r.kind !== 'secret' && !r.secret && !seen.has(r.name)) seen.set(r.name, r.kind);
    } catch {
      // buildManifest reports it
    }
  }
  const needs = [...seen].filter(([n]) => previous?.patterns[n] === undefined).map(([name, kind]) => ({ name, kind }));
  // A valid name (RUNBOOK_NAME_RE): starts with a letter or digit, at most 100 characters.
  const base =
    (fileName ?? '')
      .replace(/(\.runbook)?\.md$/i, '')
      .replace(/[^A-Za-z0-9._/-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 100) || 'runbook';
  return { ...(previous ? { previous } : {}), name: previous?.name ?? base, version: previous ? previous.version + 1 : 1, needs };
}

export interface SignInput {
  name: string;
  /** Space-separated. */
  scopes: string;
  /** Days it stays valid; empty: no expiry. */
  days: string;
  patterns: Record<string, string>;
}

/** What is wrong with the form, field by field (the core's checks come after). */
export function checkSignInput(plan: SignPlan, input: SignInput): string[] {
  const errors: string[] = [];
  if (!plan.previous && !RUNBOOK_NAME_RE.test(input.name.trim())) errors.push('name');
  if (
    !plan.previous &&
    input.scopes.trim() !== '' &&
    !input.scopes
      .trim()
      .split(/\s+/)
      .every((s) => SCOPE_RE.test(s))
  )
    errors.push('scopes');
  // 1 to 36500 days (a hundred years): a larger number is no date.
  const days = input.days.trim();
  if (days !== '' && (!/^\d{1,5}$/.test(days) || Number(days) < 1 || Number(days) > 36_500)) errors.push('days');
  for (const n of plan.needs) if ((input.patterns[n.name] ?? '').trim() === '') errors.push(`pattern:${n.name}`);
  return errors;
}

export type SignResult = { ok: true; text: string; manifest: Manifest; block: SignatureBlock } | { ok: false; errors: string[] };

/** The same signing as `b` would do: the version, and the values that need a pattern (else the card asks again). */
export const samePlan = (a: SignPlan, b: SignPlan): boolean =>
  a.version === b.version && a.name === b.name && a.needs.map((n) => n.name).join(' ') === b.needs.map((n) => n.name).join(' ');

/**
 * `block` (just signed) into the runbook as it is now: the text may have changed while the key
 * signed (a run wrote its output). Undefined when its blocks no longer make the signed manifest.
 */
export function withSignedBlock(latest: string, block: SignatureBlock): string | undefined {
  return cosignable(latest, block) ? withSignature(latest, block) : undefined;
}

const today = (now: Date): string => now.toISOString().slice(0, 10);

export async function signRunbook(
  text: string,
  plan: SignPlan,
  input: SignInput,
  signer: string,
  key: KeyPair,
  now = new Date(),
): Promise<SignResult> {
  const prev = plan.previous;
  const meta: ManifestMeta = {
    name: prev?.name ?? input.name.trim(),
    version: plan.version,
    ...(input.days.trim() !== '' ? { expires: today(new Date(now.getTime() + Number(input.days.trim()) * 86_400_000)) } : {}),
    scopes: prev?.scopes ?? (input.scopes.trim() === '' ? [] : input.scopes.trim().split(/\s+/)),
    patterns: { ...(prev?.patterns ?? {}), ...Object.fromEntries(plan.needs.map((n) => [n.name, (input.patterns[n.name] ?? '').trim()])) },
  };
  const built = buildManifest(text, meta);
  if ('errors' in built) return { ok: false, errors: built.errors };
  const manifest = formatManifest(built.manifest);
  const signature = await signSshsig(key, manifest);
  const block: SignatureBlock = { signer, signed: today(now), manifest, signature };
  return { ok: true, text: withSignature(text, block), manifest: built.manifest, block };
}

/** Why the runbook can't be co-signed now, or undefined (with its block). */
export function cosignCheck(text: string): { why: 'unsigned' | 'changed' } | { block: SignatureBlock; manifest: Manifest } {
  const block = readSignature(text);
  if (!block) return { why: 'unsigned' };
  if (!cosignable(text, block)) return { why: 'changed' };
  return { block, manifest: parseManifest(block.manifest) };
}

/**
 * The runbook with this signer's signature added to the manifest as it is (an earlier one of
 * theirs replaced). `reviewed`: the manifest the reviewer was shown; another one is refused
 * (re-signed meanwhile) rather than signed unseen.
 */
export async function cosignRunbook(text: string, signer: string, key: KeyPair, reviewed?: string, now = new Date()): Promise<SignResult> {
  const c = cosignCheck(text);
  if ('why' in c) return { ok: false, errors: [c.why] };
  if (reviewed !== undefined && c.block.manifest !== reviewed) return { ok: false, errors: ['other'] };
  const signature = await signSshsig(key, c.block.manifest);
  const cosigners = [
    ...(c.block.cosigners ?? []).filter((x) => x.signer !== signerLabel(signer)),
    { signer, signed: today(now), signature },
  ];
  const block = { ...c.block, cosigners };
  return { ok: true, text: withSignature(text, block), manifest: c.manifest, block };
}

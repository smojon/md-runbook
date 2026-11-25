/**
 * The words for a certificate on md-runbook's own key (Hosts… → md-runbook Key Certificate…):
 * its key ID, principals and dates, and the warning before and after it expires. No vscode and
 * no SSH code here (the SSH package loads on first use): the caller gives the state.
 */
import type { CertificateState, SshCertificate } from '@md-runbook/ssh';

export type CertificateFacts = Pick<SshCertificate, 'keyId' | 'principals' | 'validAfter' | 'validBefore' | 'serial' | 'caFingerprint'>;

/** `in 3 days`, `in 5 hours`, `in 12 minutes` (rounded down; at least a minute). */
export function inTime(seconds: number): string {
  const s = Math.max(60, seconds);
  const [n, unit] = s >= 2 * 86400 ? [Math.floor(s / 86400), 'day'] : s >= 2 * 3600 ? [Math.floor(s / 3600), 'hour'] : [Math.floor(s / 60), 'minute'];
  return `in ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** `2026-11-25 14:05` in local time. */
export function localTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** When it is valid, for a menu line. */
export function validityText(c: CertificateFacts, state: CertificateState, now = Date.now()): string {
  const s = now / 1000;
  if (state === 'expired') return `Expired ${localTime(c.validBefore)}`;
  if (state === 'not-yet') return `Valid from ${localTime(c.validAfter)} (${inTime(c.validAfter - s)})`;
  if (c.validBefore === Infinity) return 'Valid forever';
  return `Valid until ${localTime(c.validBefore)} (${inTime(c.validBefore - s)})`;
}

/** `alice, deploy`, or that any user goes (sshd refuses such a certificate unless told otherwise). */
export const principalsText = (c: CertificateFacts): string => (c.principals.length > 0 ? c.principals.join(', ') : 'no principals (any user)');

/** The warning to show before connecting, or undefined while it is valid. */
export function expiryWarning(c: CertificateFacts, state: CertificateState, now = Date.now()): string | undefined {
  const name = c.keyId ? `"${c.keyId}"` : 'of md-runbook’s key';
  if (state === 'expired') return `The certificate ${name} expired ${localTime(c.validBefore)}: hosts that need it refuse the login. Get a new one from your CA.`;
  if (state === 'expiring') return `The certificate ${name} expires ${inTime(c.validBefore - now / 1000)} (${localTime(c.validBefore)}). Get a new one from your CA.`;
  if (state === 'not-yet') return `The certificate ${name} is valid from ${localTime(c.validAfter)}: hosts that need it refuse the login until then.`;
  return undefined;
}

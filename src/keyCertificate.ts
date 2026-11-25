/**
 * The words for a certificate on md-runbook's own key (Hosts… → md-runbook Key Certificate…):
 * its key ID, principals and dates, and the warning before and after it expires. No vscode and
 * no SSH code here (the SSH package loads on first use): the caller gives the state.
 *
 * A certificate's text is the CA's (or anyone's who made the file): key IDs, principals and
 * options are shown escaped and cut (shownText), so they can't fake a line or reorder text.
 */
import { shownList, shownText } from '@md-runbook/core/shownText';
import type { CaSignatureCheck, CertificateState, SshCertificate } from '@md-runbook/ssh';

export type CertificateFacts = Pick<SshCertificate, 'keyId' | 'principals' | 'validAfter' | 'validBefore' | 'serial' | 'caFingerprint'>;

/** Seconds JavaScript dates reach: a certificate may say more. */
const MAX_DATE_SECONDS = 8.64e12;

/** `in 3 days`, `in 5 hours`, `in 12 minutes` (rounded down; at least a minute). */
export function inTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > MAX_DATE_SECONDS) return 'far in the future';
  const s = Math.max(60, seconds);
  const [n, unit] = s >= 2 * 86400 ? [Math.floor(s / 86400), 'day'] : s >= 2 * 3600 ? [Math.floor(s / 3600), 'hour'] : [Math.floor(s / 60), 'minute'];
  return `in ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** `2026-11-25 14:05` in local time; `far in the future` past what a date can say. */
export function localTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DATE_SECONDS) return 'far in the future';
  const d = new Date(seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The key ID, escaped and cut. */
export const keyIdText = (c: Pick<CertificateFacts, 'keyId'>): string => (c.keyId ? shownText(c.keyId) : 'no key ID');

/** When it is valid, for a menu line. */
export function validityText(c: CertificateFacts, state: CertificateState, now = Date.now()): string {
  const s = now / 1000;
  if (state === 'expired') return `Expired ${localTime(c.validBefore)}`;
  if (state === 'not-yet') return `Valid from ${localTime(c.validAfter)} (${inTime(c.validAfter - s)})`;
  if (c.validBefore === Infinity) return 'Valid forever';
  return `Valid until ${localTime(c.validBefore)} (${inTime(c.validBefore - s)})`;
}

/** `alice, deploy`, or that any user goes (sshd refuses such a certificate unless told otherwise). */
export const principalsText = (c: Pick<CertificateFacts, 'principals'>): string =>
  c.principals.length > 0 ? shownList(c.principals) : 'no principals (any user)';

/** Restrictions (critical options) by name: force-command, source-address. */
export function restrictionsText(c: Pick<SshCertificate, 'criticalOptions'>): string | undefined {
  const names = Object.keys(c.criticalOptions);
  return names.length > 0 ? shownList(names) : undefined;
}

/** The CA line: its fingerprint and whether its signature was checked here. */
export function caText(c: Pick<CertificateFacts, 'caFingerprint'>, check: CaSignatureCheck): string {
  if (check === 'valid') return `CA ${c.caFingerprint} (signature checked)`;
  if (check === 'invalid') return `CA ${c.caFingerprint}: signature not valid`;
  return `CA ${c.caFingerprint} (as the certificate says)`;
}

/** The warning to show before connecting, or undefined while it is valid. */
export function expiryWarning(c: CertificateFacts, state: CertificateState, now = Date.now()): string | undefined {
  const name = c.keyId ? `"${shownText(c.keyId)}"` : 'of md-runbook’s key';
  if (state === 'expired') return `The certificate ${name} expired ${localTime(c.validBefore)}: hosts that need it refuse the login. Get a new one from your CA.`;
  if (state === 'expiring') return `The certificate ${name} expires ${inTime(c.validBefore - now / 1000)} (${localTime(c.validBefore)}). Get a new one from your CA.`;
  if (state === 'not-yet') return `The certificate ${name} is valid from ${localTime(c.validAfter)}: hosts that need it refuse the login until then.`;
  return undefined;
}

/**
 * A certificate on the app's key: an OpenSSH user certificate from the user's company CA, for
 * hosts that trust the CA (TrustedUserCAKeys) instead of listing each key in authorized_keys.
 * The login sends the certificate; the key signs where it lives (secure hardware, keystore,
 * browser). Kept in secure storage beside the key, and dropped when the key changes.
 *
 * Not with a passkey (the web app's "Use a passkey"): security-key certificates are not checked
 * against OpenSSH here.
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import {
  CertKeyPair,
  type CertificateState,
  type SshCertificate,
  certificateLine,
  certificateState,
  certificateUsable,
  checkCaSignature,
  parseCertificate,
} from '@md-runbook/ssh';
import { useSyncExternalStore } from 'react';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';
import type { AppKey } from './appKey';

const KEY = 'app-key.cert';
/** Bigger than any certificate a CA issues (an RSA 16384 one fits). */
export const MAX_CERT_TEXT = 64 * 1024;

let current: SshCertificate | undefined;
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

/** Read the stored certificate once; an unreadable one is left out. */
export function loadAppCert(): Promise<void> {
  return (loaded ??= (async () => {
    const line = await getSecret(KEY).catch(() => null);
    try {
      current = line ? parseCertificate(line) : undefined;
    } catch {
      current = undefined;
    }
    emit();
  })());
}

export function appCert(): SshCertificate | undefined {
  return current;
}

export function useAppCert(): SshCertificate | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export class CertificateError extends Error {
  constructor(
    readonly reason: 'passkey' | 'other-key' | 'unreadable' | 'signature',
    message: string,
  ) {
    super(message);
  }
}

/** The first line with text: a `…-cert.pub` file has one. */
const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

/**
 * Check the certificate (a `…-cert.pub` line) is for `key`, then keep it. Throws a
 * CertificateError: a passkey, another key's certificate, not a user certificate, a CA signature
 * that doesn't check out (where this device can check it).
 */
export async function attachAppCert(text: string, key: AppKey): Promise<SshCertificate> {
  if (key.storage === 'passkey') throw new CertificateError('passkey', 'a passkey');
  let cert: SshCertificate;
  try {
    if (text.length > MAX_CERT_TEXT) throw new Error('too large');
    cert = parseCertificate(firstLine(text));
  } catch (e) {
    throw new CertificateError('unreadable', e instanceof Error ? e.message : String(e));
  }
  try {
    await CertKeyPair.create(key.pair, cert);
  } catch (e) {
    throw new CertificateError('other-key', e instanceof Error ? e.message : String(e));
  }
  if ((await checkCaSignature(cert)) === 'invalid') throw new CertificateError('signature', 'the CA signature is not valid');
  await setSecret(KEY, certificateLine(cert));
  current = cert;
  emit();
  return cert;
}

export async function removeAppCert(): Promise<void> {
  await deleteSecret(KEY);
  current = undefined;
  emit();
}

/** The key changed (a new one was made): its old certificate can't be used with it. */
export async function dropAppCert(): Promise<void> {
  await removeAppCert();
}

/**
 * The keys a login tries: the certificate on the key first, when within its dates (a few minutes
 * of clock skew allowed; sshd counts each key tried), then the key alone, for hosts that list it
 * in authorized_keys.
 */
export async function loginKeys(pair: KeyPair, now = Date.now()): Promise<KeyPair[]> {
  await loadAppCert();
  if (!current || !certificateUsable(current, now)) return [pair];
  try {
    return [await CertKeyPair.create(pair, current), pair];
  } catch {
    return [pair];
  }
}

/** Where the certificate is in its validity now (valid, expiring, expired, not-yet). */
export function appCertState(cert: SshCertificate, now = Date.now()): CertificateState {
  return certificateState(cert, now);
}

/** Seconds JavaScript dates reach: a certificate may say more. */
const MAX_DATE_SECONDS = 8.64e12;

/**
 * How long until `seconds` from now, rounded down: days from 2 days, hours from 2 hours, else
 * minutes (at least 1). Undefined past what a date can say.
 */
export function timeLeft(seconds: number, now = Date.now()): { n: number; unit: 'day' | 'hour' | 'minute' } | undefined {
  if (!Number.isFinite(seconds) || seconds > MAX_DATE_SECONDS) return undefined;
  const s = Math.max(60, seconds - now / 1000);
  if (s >= 2 * 86400) return { n: Math.floor(s / 86400), unit: 'day' };
  if (s >= 2 * 3600) return { n: Math.floor(s / 3600), unit: 'hour' };
  return { n: Math.floor(s / 60), unit: 'minute' };
}

/** `2026-11-25 14:05` in local time (as the extension shows it); undefined past what a date can say. */
export function localDateTime(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DATE_SECONDS) return undefined;
  const d = new Date(seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tests: forget what was read, as after a restart. */
export function resetAppCertCache(): void {
  current = undefined;
  loaded = undefined;
}

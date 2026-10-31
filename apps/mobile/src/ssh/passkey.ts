/**
 * The web app's SSH key as a passkey (WebAuthn): made by the browser's authenticator (Windows
 * Hello, Touch ID, a phone, a security key) for this site, never readable by the app, and each
 * SSH login and each signature asks the person for it. OpenSSH checks it as a security key
 * (`sk-ecdsa-sha2-nistp256@openssh.com`, @md-runbook/ssh PasskeyKeyPair); no server change.
 *
 * What the app keeps is public: the credential id, the public point and the site (rpId) it was
 * made for. A passkey belongs to one site, so the app served from another host name has none.
 */
import { type Passkey, PasskeyKeyPair, base64url } from '@md-runbook/ssh';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

const RECORD = 'app-key.passkey';
/** COSE ES256: ECDSA P-256 with SHA-256, the one curve OpenSSH's sk keys use. */
const ES256 = -7;
const TIMEOUT_MS = 120_000;

interface PasskeyRecord {
  /** The credential id, base64url. */
  id: string;
  /** The public point (0x04 ‖ X ‖ Y), base64. */
  publicKey: string;
  rpId: string;
}

/** WebAuthn here: the web app on a secure page (https, or localhost). */
export function passkeysAvailable(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
}

const fromBase64url = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

function asPasskey(r: PasskeyRecord): Passkey {
  return {
    publicKey: new Uint8Array(Buffer.from(r.publicKey, 'base64')),
    rpId: r.rpId,
    async sign(challenge) {
      const cred = (await navigator.credentials.get({
        publicKey: {
          // A copy: WebAuthn takes an ArrayBuffer-backed view only.
          challenge: new Uint8Array(challenge),
          rpId: r.rpId,
          allowCredentials: [{ type: 'public-key', id: fromBase64url(r.id) }],
          // The key's authorized_keys line says verify-required: a fingerprint, a face or a PIN.
          userVerification: 'required',
          timeout: TIMEOUT_MS,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error('the passkey was not used');
      const a = cred.response as AuthenticatorAssertionResponse;
      return {
        authenticatorData: new Uint8Array(a.authenticatorData),
        clientDataJSON: new Uint8Array(a.clientDataJSON),
        signature: new Uint8Array(a.signature),
      };
    },
  };
}

/** The passkey made earlier on this site, or undefined. */
export async function loadPasskey(): Promise<PasskeyKeyPair | undefined> {
  const raw = await getSecret(RECORD);
  if (!raw) return undefined;
  const r = JSON.parse(raw) as PasskeyRecord;
  // Made for another host name (the app moved): the browser would not use it here.
  if (r.rpId !== window.location.hostname) return undefined;
  return new PasskeyKeyPair(asPasskey(r));
}

/** Make a passkey for this site (the browser asks the person) and keep its public part. */
export async function createPasskey(): Promise<PasskeyKeyPair> {
  if (!passkeysAvailable()) throw new Error('this browser offers no passkeys here (it needs https)');
  const rpId = window.location.hostname;
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: 'md-runbook' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `md-runbook@${rpId}`, displayName: 'md-runbook SSH key' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: TIMEOUT_MS,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('no passkey was made');
  const res = cred.response as AuthenticatorAttestationResponse;
  if (res.getPublicKeyAlgorithm() !== ES256) throw new Error('the passkey is not ECDSA P-256, which OpenSSH needs');
  const spki = res.getPublicKey();
  if (!spki) throw new Error('the browser did not return the passkey’s public key');
  // A P-256 SubjectPublicKeyInfo ends with the uncompressed point.
  const point = new Uint8Array(spki).slice(-65);
  const record: PasskeyRecord = { id: base64url(new Uint8Array(cred.rawId)), publicKey: Buffer.from(point).toString('base64'), rpId };
  const pair = new PasskeyKeyPair(asPasskey(record));
  await setSecret(RECORD, JSON.stringify(record));
  return pair;
}

/** Forget it here. The passkey itself stays in the authenticator (the person removes it there). */
export function forgetPasskey(): Promise<void> {
  return deleteSecret(RECORD);
}

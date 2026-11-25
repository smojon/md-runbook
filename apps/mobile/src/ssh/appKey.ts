/**
 * The app's own SSH key (P-256, what every OpenSSH server accepts), never imported from or
 * exported to a file. The user adds its public key line to `authorized_keys` on each host.
 *
 * Where it lives:
 * - phones: made inside the secure hardware (Secure Enclave, Android Keystore) by the native
 *   HardwareKey module; the private key never reaches JavaScript, the hardware signs;
 * - a key made by an earlier version (PKCS#8 in secure storage) is kept: hosts already trust it;
 * - web: a WebCrypto key the browser won't export, kept in IndexedDB (webKey.ts); a key made by
 *   an earlier version (PKCS#8 in the browser's storage) stays until the user replaces it
 *   (replaceWithUnexportableKey), as hosts trust it;
 * - phones whose keystore can't make such keys (or a browser without WebCrypto or IndexedDB):
 *   made by the SSH library, kept in secure storage (the browser's storage on the web); a hardware
 *   key that fails otherwise is an error (shown under Hosts & settings), not a silent software key;
 * - web with "Use a passkey" on: a passkey for this site (passkey.ts); the authenticator signs.
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { ExternalKeyPair, allowedSignersLine, generateKey, importPrivateKey, privateKeyPem, publicKeyLine } from '@md-runbook/ssh';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import { RUN_SIGNATURE_NAMESPACE } from '@md-runbook/core/runReport';
import { HardwareKey } from '../../modules/hardware-key';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';
import { dropAppCert } from './appCert';
import { createPasskey, forgetPasskey, loadPasskey, passkeysAvailable } from './passkey';
import { loadWebKey, makeWebKey, removeWebKey, webKeysAvailable } from './webKey';
import { loadSettings, outputSettings, setOutputSetting } from '../settings/store';

const KEY = 'app-key.pkcs8';
const ALIAS = 'ssh-app-key';
const COMMENT = 'md-runbook-app';

/**
 * hardware: Secure Enclave / TEE / StrongBox; keystore: the platform keystore without such hardware;
 * browser: PKCS#8 in the browser's storage (readable there); browser-key: a WebCrypto key it won't export.
 */
export type KeyStorage = 'hardware' | 'keystore' | 'secure-store' | 'browser' | 'browser-key' | 'passkey';

export interface AppKey {
  pair: KeyPair;
  storage: KeyStorage;
}

let cached: Promise<AppKey> | undefined;

async function softwareKey(): Promise<AppKey> {
  const storage: KeyStorage = Platform.OS === 'web' ? 'browser' : 'secure-store';
  const pem = await getSecret(KEY);
  if (pem) {
    try {
      return { pair: await importPrivateKey(pem), storage };
    } catch {
      // Unreadable (a different format from an older version): make a new one below.
    }
  }
  const pair = await generateKey();
  await setSecret(KEY, await privateKeyPem(pair));
  return { pair, storage };
}

/** Web: the WebCrypto key made before in this browser, else a new one. */
async function browserKey(): Promise<AppKey> {
  return { pair: (await loadWebKey()) ?? (await makeWebKey()), storage: 'browser-key' };
}

async function hardwareKey(hw: NonNullable<typeof HardwareKey>): Promise<AppKey> {
  // Made with Hosts & settings' choice: whether each use asks for Face ID or a fingerprint.
  await loadSettings();
  const publicKey = (await hw.publicKey(ALIAS)) ?? (await hw.generate(ALIAS, outputSettings().keyNeedsUser)).publicKey;
  const pair = await ExternalKeyPair.create({
    publicKey: new Uint8Array(Buffer.from(publicKey, 'base64')),
    sign: async (data) => new Uint8Array(Buffer.from(await hw.sign(ALIAS, Buffer.from(data).toString('base64')), 'base64')),
  });
  return { pair, storage: (await hw.isHardware(ALIAS)) ? 'hardware' : 'keystore' };
}

/**
 * The keystore says it can't make such a key on this phone (no EC keys, no AndroidKeyStore
 * provider), rather than failing this once (busy, locked, cancelled).
 */
export const hardwareUnsupported = (e: unknown): boolean =>
  /unsupported|not supported|NoSuchAlgorithm|NoSuchProvider/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));

/**
 * The passkey made with "Use a passkey". Never made here: making one asks the person, which only
 * the switch's button may start (Safari refuses WebAuthn without a tap).
 */
async function passkeyKey(): Promise<AppKey> {
  const pair = await loadPasskey();
  if (!pair) throw new Error('no passkey for this site yet: turn "Use a passkey" off and on again to make one');
  return { pair, storage: 'passkey' };
}

/** The key and where it is kept; made on the first call. */
export function appKeyInfo(): Promise<AppKey> {
  cached ??= (async () => {
    if (passkeysAvailable()) {
      await loadSettings();
      // On the web the switch means a passkey: the authenticator asks for the person each time.
      if (outputSettings().keyNeedsUser) return passkeyKey();
    }
    // A key from an earlier version stays: the hosts have its public key.
    if ((await getSecret(KEY)) !== null) return softwareKey();
    if (Platform.OS === 'web') return webKeysAvailable() ? browserKey() : softwareKey();
    if (!HardwareKey) return softwareKey();
    try {
      return await hardwareKey(HardwareKey);
    } catch (e) {
      // A software key is kept for good (it is preferred from then on): made only when the phone
      // can't make hardware keys at all, and never when each use should ask for the user. Any other
      // failure is shown, and the next start tries the hardware again.
      if (!outputSettings().keyNeedsUser && hardwareUnsupported(e)) return softwareKey();
      throw e;
    }
  })().catch((e: unknown) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

export async function appKey(): Promise<KeyPair> {
  return (await appKeyInfo()).pair;
}

/**
 * `ecdsa-sha2-nistp256 AAAA… md-runbook-app`: the line for `authorized_keys`. A passkey's starts
 * with `verify-required`, so sshd also refuses a signature made without the person's fingerprint,
 * face or PIN.
 */
export async function appPublicKeyLine(): Promise<string> {
  const { pair, storage } = await appKeyInfo();
  const line = await publicKeyLine(pair, COMMENT);
  return storage === 'passkey' ? `verify-required ${line}` : line;
}

/** Throw the key away; the next use makes a new one (hosts then need the new public key). */
export async function resetAppKey(): Promise<void> {
  cached = undefined;
  await deleteSecret(KEY);
  // A certificate is for one key: the CA signs the new one again.
  await dropAppCert();
  await HardwareKey?.remove(ALIAS);
  if (webKeysAvailable()) await removeWebKey();
  if (passkeysAvailable()) await forgetPasskey();
}

/**
 * Web: a new key the browser won't export in place of the one in its storage (an earlier
 * version's). Hosts (authorized_keys) and servers' allowed_signers need its public key again.
 */
export async function replaceWithUnexportableKey(): Promise<AppKey> {
  // Made first: if the browser refuses, the current key stays.
  const pair = await makeWebKey();
  cached = undefined;
  await deleteSecret(KEY);
  await dropAppCert();
  cached = Promise.resolve({ pair, storage: 'browser-key' });
  return cached;
}

/**
 * Ask for Face ID, Touch ID, a fingerprint or the screen lock on every use of the key, or stop
 * asking. The hardware only enforces it on a key made that way, so this makes a new key: hosts
 * (authorized_keys) and servers' allowed_signers need its public key again. On the web, on means
 * a passkey: call this from a tap, as making one asks the person.
 */
export async function setKeyNeedsUser(on: boolean): Promise<AppKey> {
  if (on && passkeysAvailable()) {
    // Made first: a refused or cancelled passkey leaves the current key and the setting as they were.
    const pair = await createPasskey();
    setOutputSetting('keyNeedsUser', true);
    cached = undefined;
    await deleteSecret(KEY);
    await dropAppCert();
    if (webKeysAvailable()) await removeWebKey();
    cached = Promise.resolve({ pair, storage: 'passkey' });
    return cached;
  }
  setOutputSetting('keyNeedsUser', on);
  await resetAppKey();
  return appKeyInfo();
}

/** `principal namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA…`: the line for the servers' allowed_signers (signing runbooks). */
export async function appAllowedSignersLine(principal: string): Promise<string> {
  return allowedSignersLine(await appKey(), principal);
}

/**
 * `principal namespaces="md-runbook-run" ecdsa-sha2-nistp256 AAAA…`: the line for a server's
 * allowed runners file, which checks the run reports this app signs (core runReport.ts).
 */
export async function appAllowedRunnersLine(principal: string): Promise<string> {
  return allowedSignersLine(await appKey(), principal, RUN_SIGNATURE_NAMESPACE);
}

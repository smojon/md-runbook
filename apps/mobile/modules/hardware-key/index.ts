/**
 * The app's SSH key in the phone's secure hardware: the Secure Enclave on iPhones, Android
 * Keystore (StrongBox when the phone has one) on Android. The private key is made there and never
 * leaves it; the app gets the public key and asks the hardware to sign. Where there is no such
 * hardware (the iOS simulator) the key is a Keychain key, still never handed to JavaScript.
 * Absent on the web and in Jest (null).
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface GeneratedKey {
  /** Base64 of the uncompressed P-256 point (65 bytes, 0x04 ‖ X ‖ Y). */
  publicKey: string;
  /** Made inside the Secure Enclave, a TEE or StrongBox (not only stored encrypted). */
  hardware: boolean;
}

export interface HardwareKeyModule {
  /** The public key of the key named `alias`, or null when there is none. */
  publicKey(alias: string): Promise<string | null>;
  /** Make a new key named `alias` (replacing one of that name). */
  generate(alias: string): Promise<GeneratedKey>;
  /** ECDSA with SHA-256 over the base64 `data`; base64 of the DER signature. */
  sign(alias: string, data: string): Promise<string>;
  remove(alias: string): Promise<void>;
  isHardware(alias: string): Promise<boolean>;
}

export const HardwareKey = requireOptionalNativeModule<HardwareKeyModule>('HardwareKey');

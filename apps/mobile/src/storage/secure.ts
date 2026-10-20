/**
 * Secret strings on iOS and Android: the Keychain and the Android Keystore-backed store, readable
 * only after the first unlock and never restored to another device. The web has secure.web.ts.
 */
import * as SecureStore from 'expo-secure-store';

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export function getSecret(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, options);
}

export function setSecret(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value, options);
}

export function deleteSecret(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key, options);
}

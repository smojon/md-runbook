/**
 * Small JSON values the app remembers between launches (hosts, settings), on all three platforms
 * (AsyncStorage: SQLite/files on the phones, localStorage on the web). Secrets don't go here: the
 * app's private key lives in ./secure (Keychain/Keystore).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function getJson<T>(key: string, isValid: (v: unknown) => v is T): Promise<T | undefined> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return undefined;
    const v: unknown = JSON.parse(raw);
    return isValid(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

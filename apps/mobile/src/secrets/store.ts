/**
 * Stored secrets for `${secret:NAME}`, for every runbook, as the extension keeps them: the values
 * in the phone's Keychain or Keystore (storage/secure; on the web the origin's localStorage, like
 * the app's key), the names in kv so they can be listed and forgotten (the secure stores can't
 * list their keys). Values never leave the device except as a cell's environment variable.
 */
import { useSyncExternalStore } from 'react';
import { VAR_NAME_RE } from '@md-runbook/core/secrets';
import { getJson, setJson } from '../storage/kv';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

const NAMES_KEY = 'secrets.v1';
const keyOf = (name: string): string => `secret.${name}`;
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === 'string' && VAR_NAME_RE.test(n));

let names: readonly string[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

let loaded: Promise<void> | undefined;

/** Read the stored names (once); every change waits for it, so none overwrites names not read yet. */
export function loadSecretNames(): Promise<void> {
  loaded ??= getJson(NAMES_KEY, isNames).then((v) => {
    names = [...new Set([...(v ?? []), ...names])].sort();
    emit();
  });
  return loaded;
}

export async function readSecret(name: string): Promise<string | undefined> {
  if (!VAR_NAME_RE.test(name)) return undefined;
  return (await getSecret(keyOf(name))) ?? undefined;
}

export async function storeSecret(name: string, value: string): Promise<void> {
  if (!VAR_NAME_RE.test(name)) throw new Error(`not a secret name: ${name}`);
  await loadSecretNames();
  await setSecret(keyOf(name), value);
  if (!names.includes(name)) {
    names = [...names, name].sort();
    emit();
    await setJson(NAMES_KEY, names);
  }
}

export async function forgetSecret(name: string): Promise<void> {
  await loadSecretNames();
  await deleteSecret(keyOf(name));
  names = names.filter((n) => n !== name);
  emit();
  await setJson(NAMES_KEY, names);
}

export function useSecretNames(): readonly string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => names,
  );
}

/** Tests: forget the list (the values live in the secure store mock). */
export function resetSecretNames(): void {
  names = [];
  loaded = undefined;
  emit();
}

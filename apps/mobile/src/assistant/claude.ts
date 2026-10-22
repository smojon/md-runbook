/**
 * Claude through the Anthropic Messages API, with the user's own key kept in the device's secure
 * store (as the extension keeps its key in the OS keychain). One request, no streaming: the phones'
 * fetch has no streaming bodies.
 */
import { Platform } from 'react-native';
import { anthropicRequest, describeHttpError, errorMessage, isValidApiKey } from '@md-runbook/core/anthropicStream';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

const KEY = 'ai.anthropicKey';
export const MODEL = 'claude-sonnet-5-5';
export const PROVIDER_LABEL = 'Claude (Anthropic API)';

export async function hasApiKey(): Promise<boolean> {
  return (await getSecret(KEY)) !== null;
}

export async function setApiKey(key: string): Promise<void> {
  if (!isValidApiKey(key.trim())) throw new Error('the key may only contain printable characters (no spaces)');
  await setSecret(KEY, key.trim());
}

export const clearApiKey = (): Promise<void> => deleteSecret(KEY);

/** Claude's answer to `user` under `system`; rejects with a message meant for the user. */
export async function askClaude(system: string, user: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const key = await getSecret(KEY);
  if (key === null) throw new Error('no Anthropic API key is set (⋯ More → Set Anthropic API Key)');
  const req = anthropicRequest('', key, MODEL, 4000, system, user);
  const headers: Record<string, string> = { ...req.headers };
  // A browser calls the API directly with the user's own key (never a key of ours).
  if (Platform.OS === 'web') headers['anthropic-dangerous-direct-browser-access'] = 'true';
  const res = await fetcher(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...req.body, stream: false }),
    ...(signal ? { signal } : {}),
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(describeHttpError(res.status, body === undefined ? '' : errorMessage(body), MODEL));
  const content = (body as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

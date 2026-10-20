/** OpenSSH-style fingerprint (`SHA256:…`) of a public key line, for the trust prompt. */
import { Buffer } from 'buffer';

export async function fingerprint(publicKeyLine: string): Promise<string> {
  const b64 = publicKeyLine.trim().split(/\s+/)[1] ?? '';
  const bytes = Buffer.from(b64, 'base64');
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `SHA256:${Buffer.from(digest).toString('base64').replace(/=+$/, '')}`;
  } catch {
    // No SHA-256 at hand: the key's tail is still something the user can compare.
    return `…${b64.slice(-24)}`;
  }
}

/** Where a runbook's file is, so the app can save it back there (see files.ts, files.web.ts). */

export type Origin =
  /** Android: a content URI the app has a lasting read/write grant to. */
  | { kind: 'uri'; uri: string }
  /** iOS: a security-scoped bookmark to the file. */
  | { kind: 'bookmark'; bookmark: string }
  /** Web: a FileSystemFileHandle kept in IndexedDB under this id. */
  | { kind: 'handle'; id: string };

export type PickResult =
  | { kind: 'picked'; name: string; text: string; origin?: Origin }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

export function isOrigin(v: unknown): v is Origin {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === 'uri' && typeof o.uri === 'string') ||
    (o.kind === 'bookmark' && typeof o.bookmark === 'string') ||
    (o.kind === 'handle' && typeof o.id === 'string')
  );
}

/** A short fingerprint of a text (cyrb53), to notice that a file changed since the app saved it. */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}

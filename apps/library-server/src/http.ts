/** HTTP helpers: tokens, client addresses, bodies with a size cap, rate limits, append-only logs. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Token } from './config';

export type LogEvent = Record<string, string | number | boolean | undefined> & { event: string };

/** A refusal, with the HTTP status it answers. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems?: string[],
  ) {
    super(message);
  }
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Checks a token against a set in constant time: every token is compared, always. */
export function tokenSet(tokens: readonly Token[]): (given: string | undefined) => Token | undefined {
  const digests = tokens.map((t) => ({ t, d: digest(t.value) }));
  return (given) => {
    const d = digest(given ?? '');
    let hit: Token | undefined;
    for (const x of digests) if (timingSafeEqual(d, x.d) && given !== undefined) hit = hit ?? x.t;
    return hit;
  };
}

/** The bearer token of a request (`Authorization: Bearer …`); tokens in URLs are never read. */
export function bearer(req: IncomingMessage): string | undefined {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(req.headers.authorization ?? ''));
  return m ? m[1] : undefined;
}

export function clientOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (fwd.length > 0) return fwd[fwd.length - 1]!;
  }
  return req.socket.remoteAddress ?? '?';
}

/** The request's body, at most `max` bytes (413 above), as UTF-8 text (400 when it isn't). */
export async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, `the body is larger than ${max} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `the body is larger than ${max} bytes`);
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'the body is not UTF-8 text');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

/** Requests per client address in a sliding minute; the map is kept small. */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a request; false when the client is over the limit. */
  take(client: string, now = Date.now()): boolean {
    if (this.max === 0) return true;
    if (this.hits.size >= 10_000) for (const c of [...this.hits.keys()]) this.count(c, now);
    const recent = this.count(client, now);
    if (recent >= this.max) return false;
    this.hits.set(client, [...(this.hits.get(client) ?? []), now]);
    return true;
  }

  /** How many requests (or failures) the client made in the window. */
  count(client: string, now = Date.now()): number {
    const list = (this.hits.get(client) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length > 0) this.hits.set(client, list);
    else this.hits.delete(client);
    return list.length;
  }

  add(client: string, now = Date.now()): void {
    this.hits.set(client, [...(this.hits.get(client) ?? []), now]);
  }
}

/** Runs one task at a time (writes to the library, appends to a log). */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.last.then(task, task);
    this.last = next.catch(() => undefined);
    return next;
  }
}

/**
 * An append-only log of JSON lines, one file per month (`<prefix>-2026-11.jsonl`). Lines are never
 * changed or removed by the server; rotate or archive old months yourself.
 */
export class JsonLog {
  private readonly lock = new Mutex();
  constructor(
    private readonly dir: string,
    private readonly prefix: string,
  ) {}

  append(record: object, now = new Date()): Promise<void> {
    const file = join(this.dir, `${this.prefix}-${now.toISOString().slice(0, 7)}.jsonl`);
    return this.lock.run(async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o750 });
      await fsp.appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o640, flag: 'a' });
    });
  }

  /** Records, newest first, that `keep` accepts, at most `limit`, from the last `months` files. */
  async recent<T>(keep: (r: T) => boolean, limit: number, months = 12): Promise<T[]> {
    let files: string[];
    try {
      files = (await fsp.readdir(this.dir)).filter((f) => new RegExp(`^${this.prefix}-\\d{4}-\\d{2}\\.jsonl$`).test(f));
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const f of files.sort().reverse().slice(0, months)) {
      const lines = (await fsp.readFile(join(this.dir, f), 'utf8')).split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!;
        if (line.trim() === '') continue;
        try {
          const r = JSON.parse(line) as T;
          if (keep(r)) out.push(r);
        } catch {
          // a damaged line (cut by a full disk): skipped
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** `limit=` of a list request: 1 to `max`, `fallback` when absent. */
export function limitOf(url: URL, fallback: number, max: number): number {
  const v = url.searchParams.get('limit');
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit: expected a whole number from 1');
  return Math.min(n, max);
}

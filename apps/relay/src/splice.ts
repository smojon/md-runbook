/**
 * Copies bytes between two ends of a session: a WebSocket and a TCP socket (v1, `/v1/ssh`), or
 * two WebSockets (pairing mode). Each end says when it has room again, so a slow reader on one
 * side pauses reading on the other: memory stays bounded both ways.
 */
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';

/** Bytes queued towards a WebSocket peer above which reading from the other side pauses. */
export const HIGH_WATER = 1 << 20;
/** How long a closing WebSocket may wait for the peer's answer before its socket is cut. */
export const CLOSE_GRACE_MS = 1000;

/**
 * Close with a code, and cut the socket if the peer hasn't answered within CLOSE_GRACE_MS (ws
 * itself would wait 30 s for a peer that may be gone).
 */
export function closeSoon(ws: WebSocket, code: number, reason?: string): void {
  ws.close(code, reason);
  setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
}

/**
 * How an end is closed.
 * - `graceful`: after what is still queued (WebSocket: 1000; its close timeout cuts a peer that
 *   never reads).
 * - `error`: WebSocket 1011, also after the queue.
 * - `cut`: at once, no close handshake (a peer that missed a ping won't answer one).
 * - `lifetime`, `shutdown`: 1000 or 1001, cut after CLOSE_GRACE_MS whatever is still queued.
 * A TCP socket is destroyed in every case.
 */
export type Ending = 'graceful' | 'error' | 'cut' | 'lifetime' | 'shutdown';

export interface EndEvents {
  data(b: Buffer): void;
  /** The peer closed normally. */
  closed(why: string): void;
  /** Something went wrong; `cut`: end this side at once (a missed pong). */
  failed(why: string, cut?: boolean): void;
}

export interface End {
  /** Sends; false when over the high-water mark, and `room` is then called once there is room. */
  write(b: Buffer, room: () => void): boolean;
  pause(): void;
  resume(): void;
  start(on: EndEvents): void;
  end(how: Ending): void;
  /** Bytes queued towards this end's peer. */
  buffered(): number;
}

/** What a WebSocket end calls its events in the log. */
export interface WsLabels {
  closed: string;
  error: string;
  text: string;
  pong: string;
}

/**
 * A WebSocket end. Binary frames are the data; a text frame ends the session. It pings its peer
 * every `pingIntervalMs`: a peer that misses a pong is cut (dead laptops, lost networks).
 */
export function wsEnd(ws: WebSocket, labels: WsLabels, pingIntervalMs: number): End {
  let waiting = false;
  let ping: NodeJS.Timeout | undefined;
  return {
    write(b, room) {
      ws.send(b, () => {
        if (waiting && ws.bufferedAmount < HIGH_WATER) {
          waiting = false;
          room();
        }
      });
      if (ws.bufferedAmount < HIGH_WATER) return true;
      waiting = true;
      return false;
    },
    pause: () => ws.pause(),
    resume: () => ws.resume(),
    start(on) {
      ws.on('message', (data: Buffer, isBinary: boolean) => (isBinary ? on.data(data) : on.failed(labels.text)));
      ws.on('close', () => on.closed(labels.closed));
      ws.on('error', () => on.failed(labels.error));
      let alive = true;
      ws.on('pong', () => (alive = true));
      ping = setInterval(() => {
        if (!alive) return on.failed(labels.pong, true);
        alive = false;
        ws.ping();
      }, pingIntervalMs);
      ping.unref();
    },
    end(how) {
      clearInterval(ping);
      if (how === 'cut') ws.terminate();
      else if (how === 'lifetime') closeSoon(ws, 1000, 'session lifetime');
      else if (how === 'shutdown') closeSoon(ws, 1001);
      else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(how === 'graceful' ? 1000 : 1011);
    },
    buffered: () => ws.bufferedAmount,
  };
}

/** A TCP end, being connected: `connect` with a timeout, cleared once connected. */
export function tcpEnd(tcp: Socket): End {
  return {
    write(b, room) {
      if (tcp.write(b)) return true;
      tcp.once('drain', room);
      return false;
    },
    pause: () => tcp.pause(),
    resume: () => tcp.resume(),
    start(on) {
      tcp.on('connect', () => tcp.setTimeout(0));
      tcp.on('timeout', () => on.failed('connect timeout'));
      tcp.on('error', (e: NodeJS.ErrnoException) => on.failed(`target error ${e.code ?? e.message}`));
      tcp.on('close', () => on.closed('target closed'));
      tcp.on('data', (b: Buffer) => on.data(b));
    },
    end: () => tcp.destroy(),
    buffered: () => tcp.writableLength,
  };
}

export interface Splice {
  /** Ends the session: its lifetime is up, or the relay stops. */
  stop(how: 'lifetime' | 'shutdown'): void;
  /** Bytes queued towards both peers. */
  buffered(): number;
}

/**
 * Copies `a` (the client) to `b` and back until either side ends, or `maxSessionMs` passes.
 * `onEnd` gets why, and the bytes each way: `up` from `a`, `down` from `b`.
 *
 * When one side closes normally, the other is closed gracefully: the close frame goes after what
 * is still queued (up to HIGH_WATER and a chunk, the server's last output). On an error the
 * other side gets 1011. A missed pong cuts that side at once.
 */
export function splice(a: End, b: End, opts: { maxSessionMs: number; onEnd(why: string, up: number, down: number): void }): Splice {
  let up = 0;
  let down = 0;
  let over = false;
  const done = (why: string, cause: End | undefined, kind: 'closed' | 'failed' | 'cut' | 'lifetime' | 'shutdown'): void => {
    if (over) return;
    over = true;
    clearTimeout(lifetime);
    if (kind === 'lifetime' || kind === 'shutdown' || cause === undefined) {
      a.end(kind === 'shutdown' ? 'shutdown' : 'lifetime');
      b.end(kind === 'shutdown' ? 'shutdown' : 'lifetime');
    } else {
      const other = cause === a ? b : a;
      cause.end(kind === 'cut' ? 'cut' : kind === 'closed' ? 'graceful' : 'error');
      other.end(kind === 'closed' ? 'graceful' : 'error');
    }
    opts.onEnd(why, up, down);
  };
  // However busy, a session ends after maxSessionMs: a leaked token's session can't last for ever.
  const lifetime = setTimeout(() => done('session lifetime', undefined, 'lifetime'), opts.maxSessionMs);
  lifetime.unref();

  const flow =
    (from: End, to: End, count: (n: number) => void) =>
    (chunk: Buffer): void => {
      if (over) return;
      count(chunk.length);
      if (!to.write(chunk, () => from.resume())) from.pause();
    };
  const events = (self: End, data: (b: Buffer) => void): EndEvents => ({
    data,
    closed: (why) => done(why, self, 'closed'),
    failed: (why, cut) => done(why, self, cut ? 'cut' : 'failed'),
  });
  b.start(events(b, flow(b, a, (n) => (down += n))));
  a.start(events(a, flow(a, b, (n) => (up += n))));

  return {
    stop: (how) => done(how === 'lifetime' ? 'session lifetime' : 'relay stopping', undefined, how),
    buffered: () => a.buffered() + b.buffered(),
  };
}

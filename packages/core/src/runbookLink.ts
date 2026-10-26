/**
 * Runbook links: one format for VS Code's Open in the App, QR codes on machines, links in pager
 * alerts and "please co-sign" requests.
 *
 *   mdrunbook://open?url=https%3A%2F%2F…&sha256=…&host=web-1&p.SERVICE=api&action=cosign
 *   https://<the web app>/open?…            (the same, for a browser or a phone's camera)
 *   mdrunbook://open?rb=…                    (the runbook itself, compressed: no network needed)
 *
 * A link only opens a runbook and fills in what it names; it never runs anything. `sha256` pins
 * the content (the app refuses another text), `host` picks a host the app already has, `p.NAME`
 * fills a parameter (a signed runbook still checks its pattern, and md-runbook-gate again).
 */

import { deflateSync, Inflate } from 'fflate';
import { parse } from './parser';
import { VAR_NAME_RE, findRefs, parseFrontMatter } from './secrets';
import { sha256Hex } from './sha256';
import { signedStatus } from './signing';

export interface RunbookLink {
  /** Where the runbook is (https only). */
  url?: string;
  /** The runbook's text, carried in the link (`rb=`). */
  text?: string;
  /** Expected SHA-256 of the text (lower-case hex, after a leading BOM is dropped). */
  sha256?: string;
  /** The name of a host in the app to run on. */
  host?: string;
  /** Parameter values, by name. */
  params: Record<string, string>;
  /** `cosign`: open on the Co-sign Runbook card. */
  action?: 'cosign';
}

export const APP_LINK_BASE = 'mdrunbook://open';
/** Most a link's runbook may unpack to: a QR code holds ~3 KB, but a mail link can hold more. */
export const MAX_LINK_TEXT_BYTES = 256 * 1024;
const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type LinkProblem = 'not-a-link' | 'no-runbook' | 'both' | 'not-https' | 'bad-text' | 'too-large' | 'bad-sha256' | 'bad-host' | 'bad-param';

/**
 * Read a link: an app link (`mdrunbook://open?…`), the web app's `…/open?…`, or a plain https
 * address of a runbook (as before runbook links). Unknown query fields are ignored, so older apps
 * open newer links.
 */
export function parseRunbookLink(link: string): { ok: true; link: RunbookLink } | { ok: false; problem: LinkProblem } {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return { ok: false, problem: 'not-a-link' };
  }
  const q = u.searchParams;
  const isAppLink = u.protocol === 'mdrunbook:' || (u.protocol === 'https:' && /\/open\/?$/.test(u.pathname) && (q.has('url') || q.has('rb')));
  if (!isAppLink) return u.protocol === 'https:' ? { ok: true, link: { url: u.toString(), params: {} } } : { ok: false, problem: 'not-a-link' };

  const out: RunbookLink = { params: {} };
  const url = q.get('url');
  const rb = q.get('rb');
  if (url !== null && rb !== null) return { ok: false, problem: 'both' };
  if (url !== null) {
    try {
      if (new URL(url).protocol !== 'https:') return { ok: false, problem: 'not-https' };
    } catch {
      return { ok: false, problem: 'not-https' };
    }
    out.url = url;
  } else if (rb !== null) {
    const text = unpackText(rb);
    if (typeof text !== 'string') return { ok: false, problem: text.problem };
    out.text = text;
  } else return { ok: false, problem: 'no-runbook' };

  const sha = q.get('sha256');
  if (sha !== null) {
    if (!SHA256_RE.test(sha.toLowerCase())) return { ok: false, problem: 'bad-sha256' };
    out.sha256 = sha.toLowerCase();
  }
  const host = q.get('host');
  if (host !== null) {
    if (!HOST_NAME_RE.test(host)) return { ok: false, problem: 'bad-host' };
    out.host = host;
  }
  for (const [k, v] of q) {
    if (!k.startsWith('p.')) continue;
    const name = k.slice(2);
    // One line each: a value can't carry a second command (the app and the gate check again).
    if (!VAR_NAME_RE.test(name) || /[\r\n]/.test(v)) return { ok: false, problem: 'bad-param' };
    out.params[name] = v;
  }
  if (q.get('action') === 'cosign') out.action = 'cosign';
  return { ok: true, link: out };
}

/** The link for `l`: an app link by default, or the web app's with `base` = `https://…/open`. */
export function formatRunbookLink(l: RunbookLink, base: string = APP_LINK_BASE): string {
  // encodeURIComponent, not URLSearchParams: a space stays %20 (apps before runbook links read
  // url= without turning + into a space).
  const q: string[] = [];
  const add = (k: string, v: string): number => q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  if (l.url !== undefined) add('url', l.url);
  else if (l.text !== undefined) add('rb', packText(l.text));
  if (l.sha256) add('sha256', l.sha256);
  if (l.host) add('host', l.host);
  for (const [k, v] of Object.entries(l.params)) add(`p.${k}`, v);
  if (l.action) add('action', l.action);
  return `${base}?${q.join('&')}`;
}

/** The digest a link pins: SHA-256 of the text without a leading BOM (fetch drops it anyway). */
export function runbookDigest(text: string): string {
  return sha256Hex(text.replace(/^﻿/, ''));
}

/**
 * How far the opened text can be trusted. `mismatch`: the link pins other content (refuse it);
 * `signed`: the runbook carries a signature block and no signed block changed; `pinned`: the
 * text at the link's address is the one the link pins; `unverified`: neither (open it, with a
 * warning). Only a signature says who approved a runbook: a forged link or sticker can pin its
 * own text, so a pin guards a genuine link against the file changing later, nothing more, and a
 * runbook carried in the link (rb=) is never `pinned` (its pin would come with it).
 */
export type LinkTrust = 'mismatch' | 'signed' | 'pinned' | 'unverified';

export function linkTrust(l: RunbookLink, text: string): LinkTrust {
  if (l.sha256 && runbookDigest(text) !== l.sha256) return 'mismatch';
  const signed = signedStatus(text);
  if (signed && signed.changed.length === 0 && signed.missing.length === 0 && signed.moved.length === 0) return 'signed';
  return l.sha256 && l.text === undefined ? 'pinned' : 'unverified';
}

/**
 * The parameters a link can fill for this runbook: the front matter's `params:` (with their
 * defaults), then every other `${param:NAME}` its code cells use, in order.
 */
export function linkableParams(text: string): { name: string; default?: string }[] {
  const out = [...(parseFrontMatter(text)?.params ?? [])];
  for (const cell of parse(text).cells) {
    if (cell.kind !== 'code') continue;
    for (const ref of findRefs(cell.value)) if (ref.kind === 'param' && !out.some((p) => p.name === ref.name)) out.push({ name: ref.name });
  }
  return out;
}

/** `rb=`: the text deflated (raw), in base64url. */
export function packText(text: string): string {
  return toBase64Url(deflateSync(new TextEncoder().encode(text), { level: 9 }));
}

/** The text `packText` made (rb=, and other packed link fields), or why it can't be read. */
export function unpackText(packed: string): string | { problem: 'bad-text' | 'too-large' } {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(packed);
  } catch {
    return { problem: 'bad-text' };
  }
  // Inflated in chunks with a limit: a small link can't unpack to gigabytes.
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tooLarge = false;
  const inflate = new Inflate((chunk) => {
    size += chunk.length;
    if (size > MAX_LINK_TEXT_BYTES) tooLarge = true;
    else chunks.push(chunk);
  });
  try {
    for (let i = 0; i < bytes.length && !tooLarge; i += 4096) inflate.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
  } catch {
    return { problem: 'bad-text' };
  }
  if (tooLarge) return { problem: 'too-large' };
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  try {
    return new TextDecoder().decode(all);
  } catch {
    return { problem: 'bad-text' };
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) s += B64[n & 63]!;
  }
  return s;
}

function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/[^A-Za-z0-9_-]/.test(clean) || clean.length % 4 === 1) throw new Error('not base64url');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
}

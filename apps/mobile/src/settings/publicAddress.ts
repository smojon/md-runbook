/**
 * The web app's public address: what share links, QR codes and pairing links start with, instead
 * of the address the page was opened from (http://localhost:8080 on the laptop that runs the
 * container, while phones reach it through a tunnel or a reverse proxy). In order: Hosts &
 * settings → Public address of this web app, the container's MD_RUNBOOK_PUBLIC_URL
 * (runtimeConfig.ts), the page's own origin. None on the phones.
 */
import { APP_LINK_BASE } from '@md-runbook/core/runbookLink';
import { publicUrlSetting } from './store';
import { normalizePublicUrl, pageOrigin, publicUrlProblem, runtimeConfig } from './runtimeConfig';

export type PublicBaseSource = 'setting' | 'container' | 'page';

/** The public address (no trailing slash) and where it comes from; undefined when there is none. */
export function publicBaseOf(): { base: string; source: PublicBaseSource } | undefined {
  const set = publicUrlSetting();
  if (set && publicUrlProblem(set) === undefined) return { base: normalizePublicUrl(set), source: 'setting' };
  const fromContainer = runtimeConfig().publicUrl;
  if (fromContainer) return { base: fromContainer, source: 'container' };
  const origin = pageOrigin();
  return origin ? { base: origin, source: 'page' } : undefined;
}

export const publicBase = (): string | undefined => publicBaseOf()?.base;

/**
 * An address on the page's own origin as others reach it: the origin swapped for the public
 * address (`http://localhost:8080/runbooks/a.md` → `https://ops.example.net/runbooks/a.md`).
 * Any other address is returned as it is.
 */
export function toPublicUrl(url: string): string {
  const origin = pageOrigin();
  const base = publicBase();
  if (!origin || !base || base === origin) return url;
  return url === origin || url.startsWith(origin + '/') ? base + url.slice(origin.length) : url;
}

/** The other way: an address under the public one, as this page fetches it (its own origin). */
export function fromPublicUrl(url: string): string {
  const origin = pageOrigin();
  const base = publicBase();
  if (!origin || !base || base === origin) return url;
  return url === base || url.startsWith(base + '/') ? origin + url.slice(base.length) : url;
}

/** A relay address (wss:// or https://) on the page's origin, as others reach it. */
export function toPublicRelayUrl(url: string): string {
  const http = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/^ws(s?):\/\//i, 'http$1://');
  const pub = toPublicUrl(http);
  return pub === http ? url.trim() : pub.replace(/^http(s?):\/\//i, 'ws$1://');
}

/**
 * Where runbook links and QR codes point: the web app's `…/open` when its public address is https
 * (a phone's camera opens it in the browser, or in the app where it handles the address), else
 * the app's own `mdrunbook://open` (http links are not runbook links: core/runbookLink.ts).
 */
export function openLinkBase(): string {
  const base = publicBase();
  return base && base.startsWith('https://') ? `${base}/open` : APP_LINK_BASE;
}

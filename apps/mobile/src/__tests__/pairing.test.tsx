/**
 * Setting up a web app for a phone's browser: the relay on the app's own origin, pairing by code
 * or link (the token never in a query), hosts lists that name the relay, the container's runtime
 * configuration (public address, library folder), QR codes that link to a runbook's address, and
 * links into the team library that open its copy there.
 */
import { clearOutputBlocks } from '@md-runbook/core';
import { formatRunbookLink, parseRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';
import { hostsJson, hostsLink, readHosts } from '../hosts/share';
import { addHost, getHosts, pinHostKey, resetHosts } from '../hosts/store';
import { PAIR_PREFIX, decodePairing, encodePairing, looksLikePairing, pairingLink } from '../pairing/payload';
import { capturePairingFragment, clearPendingPairing, pairingFragmentInRoute, pendingPairing, setPendingPairing } from '../pairing/pending';
import { qrLink, runbookAddress } from '../runbooks/address';
import { defaultLibraryBase, libraryState, libraryTarget, openLibraryRunbook, refreshLibrary, resetLibrary } from '../runbooks/library';
import { linkContext } from '../runbooks/linkContext';
import { openRunbookLink } from '../runbooks/openLink';
import { paramValues, resetParamValues } from '../runbooks/params';
import { addRunbook, getRunbook, linkKey, resetRunbooks, updateRunbookText, useRunbooks } from '../runbooks/store';
import { PAIR_SHOW_MS, PairDeviceCard, PairScreen } from '../screens/Pairing';
import { fromPublicUrl, openLinkBase, publicBaseOf, toPublicRelayUrl, toPublicUrl } from '../settings/publicAddress';
import { loadRuntimeConfig, parseRuntimeConfig, resetRuntimeConfig, runtimeConfig } from '../settings/runtimeConfig';
import { resetSettings, setLibraryUrl, setOutputSetting, setPublicUrl } from '../settings/store';
import { loadTrustedSigners, resetTrustedSigners, trustSigners, trustedSigners } from '../signing/trust';
import { compareWithHint, hintsFrom, resetSignerHints, signerHintFor } from '../pairing/signerHints';
import {
  getRelaySettings,
  getRelayUrlSetting,
  relayUrlProblem,
  resetSameOriginRelay,
  sameOriginRelay,
  setRelaySettings,
} from '../ssh/relaySettings';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
  useLocalSearchParams: () => ({}),
}));
jest.mock('../ssh/appKey', () => ({
  appPublicKeyLine: async () => 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAI md-runbook-app',
  appKey: async () => undefined,
}));

const TOKEN = 'b04d6752122db1e60570b22f6eb68c93f9fb013f4466962cc33ea0c125920c43';
const PUBLIC = 'https://ops-tunnel.trycloudflare.com';
/** Key fingerprints as ssh-keygen -l shows them. */
const FP_A = 'SHA256:' + 'A'.repeat(43);
const FP_B = 'SHA256:' + 'B'.repeat(43);
const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart ${param:SERVICE}\n```\n';

/** A fetch that answers from a table of URLs (anything else: 404). */
function server(files: Record<string, string | object>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const v = files[url];
    const body = typeof v === 'object' ? JSON.stringify(v) : v;
    return body === undefined
      ? { ok: false, status: 404, url, headers: new Headers(), text: async () => '', json: async () => JSON.parse('x') }
      : { ok: true, status: 200, url, headers: new Headers(), text: async () => body, json: async () => JSON.parse(body) };
  }) as unknown as typeof fetch;
}

/** The web app, opened at `origin`, for the rest of the test. */
function onTheWeb(origin: string): void {
  jest.replaceProperty(Platform, 'OS', 'web');
  (globalThis as { location?: unknown }).location = { origin };
}

const SERVER_INFO = { name: 'md-runbook-relay', protocol: 1, version: '1.0.0', capabilities: ['ssh'] };

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunbooks();
  resetSettings();
  resetHosts();
  resetLibrary();
  resetTrustedSigners();
  resetSignerHints();
  resetParamValues();
  resetRuntimeConfig({});
  resetSameOriginRelay();
  clearPendingPairing();
  await setRelaySettings(undefined);
});
afterEach(() => {
  delete (globalThis as { location?: unknown }).location;
  jest.restoreAllMocks();
});

describe('the relay on the web app’s own origin', () => {
  it('is the default address when the origin answers /v1/server-info as a relay; the user still gives the token', async () => {
    onTheWeb(PUBLIC);
    const seen: string[] = [];
    expect(await sameOriginRelay(server({ [`${PUBLIC}/v1/server-info`]: SERVER_INFO }, seen))).toBe('wss://ops-tunnel.trycloudflare.com');
    expect(seen).toEqual([`${PUBLIC}/v1/server-info`]);
    // No token yet: nothing to connect with.
    expect(await getRelaySettings()).toBeUndefined();
    await setRelaySettings({ url: '', token: TOKEN });
    expect(await getRelaySettings()).toEqual({ url: 'wss://ops-tunnel.trycloudflare.com', token: TOKEN, sameOrigin: true });
    // Saved with the address shown: stored as "this server's relay", not as an address of its own.
    await setRelaySettings({ url: 'wss://ops-tunnel.trycloudflare.com', token: TOKEN });
    expect(await getRelayUrlSetting()).toBe('');
  });

  it('never replaces an address the user set', async () => {
    onTheWeb(PUBLIC);
    await sameOriginRelay(server({ [`${PUBLIC}/v1/server-info`]: SERVER_INFO }));
    await setRelaySettings({ url: 'wss://relay.example.net', token: TOKEN });
    expect(await getRelaySettings()).toEqual({ url: 'wss://relay.example.net', token: TOKEN });
  });

  it('an origin that answers with the app’s page (or nothing) is no relay; nor on the phones', async () => {
    onTheWeb('https://app.example.net');
    expect(await sameOriginRelay(server({ 'https://app.example.net/v1/server-info': '<!doctype html><html></html>' }))).toBeUndefined();
    resetSameOriginRelay();
    expect(
      await sameOriginRelay(server({ 'https://app.example.net/v1/server-info': { name: 'something else', protocol: 1 } })),
    ).toBeUndefined();
    resetSameOriginRelay();
    jest.replaceProperty(Platform, 'OS', 'ios');
    const seen: string[] = [];
    expect(await sameOriginRelay(server({}, seen))).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('relay addresses: wss or https; ws and http on this machine only', () => {
    expect(relayUrlProblem('wss://relay.example.net')).toBeUndefined();
    expect(relayUrlProblem('https://relay.example.net/')).toBeUndefined();
    expect(relayUrlProblem('ws://localhost:8022')).toBeUndefined();
    expect(relayUrlProblem('ws://127.0.0.1:8022')).toBeUndefined();
    // The web app's security policy blocks it: refused, not taken and then failing (security review round 4).
    expect(relayUrlProblem('ws://[::1]:8022')).toBe('loopback6');
    expect(relayUrlProblem('wss://[::1]:8022')).toBeUndefined();
    expect(relayUrlProblem('ws://relay.example.net')).toBe('insecure');
    expect(relayUrlProblem('wss://relay.example.net/?token=x')).toBe('invalid');
    expect(relayUrlProblem('wss://user@relay.example.net')).toBe('invalid');
    expect(relayUrlProblem('javascript:alert(1)')).toBe('invalid');
  });
});

describe('the pairing payload', () => {
  const hosts = [{ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy', hostKey: 'ecdsa-sha2-nistp256 AAAAkey=' }];

  it('round-trips, with a type marker that tells it from the other codes', () => {
    const payload = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, hosts });
    expect(payload.startsWith(PAIR_PREFIX)).toBe(true);
    expect(PAIR_PREFIX).toBe('mdrb-pair.v1.');
    // base64url after the marker: fits a fragment and a QR code as it is.
    expect(payload.slice(PAIR_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePairing(payload)).toEqual({ pairing: { relay: 'wss://ops.example.net', token: TOKEN, hosts } });
    expect(looksLikePairing(payload)).toBe(true);
    // Not a runbook, hosts or library link; and those aren't pairings.
    expect(parseRunbookLink(payload).ok).toBe(false);
    expect(readHosts(payload)).toMatchObject({ error: expect.any(String) });
    for (const other of [
      formatRunbookLink({ text: RUNBOOK, params: {} }),
      hostsLink([], false),
      'mdrunbook://library?url=https%3A%2F%2Fx.example.net%2F',
    ])
      expect(looksLikePairing(other)).toBe(false);
  });

  it('a pairing link carries it in the fragment, which the decoder reads as well', () => {
    const payload = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN });
    const link = pairingLink(PUBLIC + '/', payload);
    expect(link).toBe(`${PUBLIC}/pair#${payload}`);
    const u = new URL(link);
    expect(u.search).toBe('');
    expect(u.hash).toBe('#' + payload);
    expect(decodePairing(link)).toEqual({ pairing: { relay: 'wss://ops.example.net', token: TOKEN } });
    // The payload in a query is not a pairing link.
    expect(looksLikePairing(`${PUBLIC}/pair?p=${payload}`)).toBe(false);
  });

  it('a newer version, a damaged code, a token a browser can’t send or a bad host are refused', () => {
    const payload = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN });
    expect(decodePairing(payload.replace('v1.', 'v2.'))).toEqual({ problem: 'newer' });
    expect(decodePairing(payload.slice(0, 30))).toEqual({ problem: 'damaged' });
    expect(decodePairing('hello')).toEqual({ problem: 'not-pairing' });
    expect(decodePairing(encodePairing({ relay: 'wss://ops.example.net', token: 'a/b=' }))).toEqual({ problem: 'damaged' });
    expect(decodePairing(encodePairing({ relay: 'http://ops.example.net', token: TOKEN }))).toEqual({ problem: 'damaged' });
    const bad = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, hosts: [{ ...hosts[0]!, hostname: 'web 1' }] });
    expect(decodePairing(bad)).toEqual({ error: expect.stringMatching(/web-1/) });
  });

  it('may carry the signers the device trusts per library, to compare with; checked strictly', () => {
    const signers = [{ library: 'https://Runbooks.example.net/team', fingerprints: [FP_A, FP_B, FP_A] }];
    const read = decodePairing(encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, signers }));
    // The address as compared (lower-case host, ending in /), each key once.
    expect(read).toEqual({
      pairing: {
        relay: 'wss://ops.example.net',
        token: TOKEN,
        signers: [{ library: 'https://runbooks.example.net/team/', fingerprints: [FP_A, FP_B] }],
      },
    });
    const pack = (s: unknown): string => encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, signers: s as never });
    for (const bad of [
      [{ library: 'https://x.example.net/', fingerprints: ['MD5:00'] }],
      [{ library: 'ftp://x.example.net/', fingerprints: [FP_A] }],
      [{ library: 'https://user@x.example.net/', fingerprints: [FP_A] }],
      [{ library: 'https://x.example.net/', fingerprints: [] }],
      [
        { library: 'https://x.example.net/', fingerprints: [FP_A] },
        { library: 'https://X.example.net', fingerprints: [FP_B] },
      ],
      Array.from({ length: 9 }, (_, i) => ({ library: `https://x${i}.example.net/`, fingerprints: [FP_A] })),
      [{ library: 'https://x.example.net/', fingerprints: Array.from({ length: 33 }, () => FP_A) }],
      'nope',
    ])
      expect(decodePairing(pack(bad))).toEqual({ problem: 'damaged' });
  });

  it('the signers to send: per library at its public address, still published, never the keys added by you', () => {
    onTheWeb('http://localhost:8080');
    setPublicUrl(PUBLIC);
    const key = (fingerprint: string, from: string, withdrawn?: boolean) => ({
      principals: ['a@example.net'],
      keyType: 'ssh-ed25519',
      key: 'AAAA',
      fingerprint,
      from,
      ...(withdrawn ? { withdrawn } : {}),
    });
    expect(
      hintsFrom([
        key(FP_A, 'http://localhost:8080/runbooks/'),
        key(FP_B, 'http://localhost:8080/runbooks/', true),
        key(FP_B, 'https://lib.example.net/x/'),
        key(FP_A, 'you'),
      ]),
    ).toEqual([
      { library: PUBLIC + '/runbooks/', fingerprints: [FP_A] },
      { library: 'https://lib.example.net/x/', fingerprints: [FP_B] },
    ]);
    expect(compareWithHint([{ fingerprint: FP_A }], { library: 'x', fingerprints: [FP_A] }).same).toBe(true);
    expect(compareWithHint([{ fingerprint: FP_A }, { fingerprint: FP_B }], { library: 'x', fingerprints: [FP_A] })).toMatchObject({
      same: false,
      notThere: 1,
      missingHere: 0,
    });
  });
});

describe('a pairing link', () => {
  const page = (pathname: string, hash: string) => {
    const replaceState = jest.fn((_s: unknown, _u: string, url?: string) => {
      const u = new URL(url ?? '', 'https://x.invalid');
      loc.pathname = u.pathname;
      loc.search = u.search;
      loc.hash = u.hash;
    });
    const loc = { pathname, search: '', hash };
    return { location: loc, history: { replaceState, state: { key: 1 } } };
  };

  it('is read once on load and removed from the address bar', () => {
    const payload = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN });
    const p = page('/pair', '#' + payload);
    expect(capturePairingFragment(p)).toBe(true);
    expect(p.history.replaceState).toHaveBeenCalledWith({ key: 1 }, '', '/pair');
    expect(p.location.hash).toBe('');
    expect(pendingPairing()).toEqual({ payload, source: 'link' });
    // Nothing left to read a second time.
    expect(capturePairingFragment(p)).toBe(false);
    expect(p.history.replaceState).toHaveBeenCalledTimes(1);
    clearPendingPairing();
    expect(pendingPairing()).toBeUndefined();
  });

  it('other pages and other fragments are left alone', () => {
    const p = page('/runbook/x', '#' + encodePairing({ relay: 'wss://ops.example.net', token: TOKEN }));
    expect(capturePairingFragment(p)).toBe(false);
    const q = page('/pair', '#section');
    expect(capturePairingFragment(q)).toBe(false);
    expect(p.history.replaceState).not.toHaveBeenCalled();
    expect(q.history.replaceState).not.toHaveBeenCalled();
  });
});

describe('no token in any URL query', () => {
  it('pairing links, hosts links (with the relay), runbook links and library links', async () => {
    onTheWeb('http://localhost:8080');
    setPublicUrl(PUBLIC);
    const h = addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    pinHostKey(h.id, 'ecdsa-sha2-nistp256 AAAAkey=');
    await setRelaySettings({ url: 'ws://localhost:8080', token: TOKEN });
    const relay = await getRelaySettings();
    const payload = encodePairing({ relay: toPublicRelayUrl(relay!.url), token: relay!.token, hosts: [] });
    const r = addRunbook('restart.md', RUNBOOK);
    const links = [
      pairingLink(publicBaseOf()!.base, payload),
      hostsLink(getHosts(), true, toPublicRelayUrl(relay!.url)),
      qrLink(r, undefined, { params: { SERVICE: 'api' } }),
      qrLink(r, { url: `${PUBLIC}/runbooks/restart.md`, sha256: runbookDigest(RUNBOOK) }, { host: 'web-1', params: {} }),
    ];
    for (const link of links) {
      const u = new URL(link);
      // The token appears in no query field, packed or not.
      for (const [, v] of u.searchParams) {
        expect(v).not.toContain(TOKEN);
        const packed = readHosts(v);
        if ('hosts' in packed) expect(JSON.stringify(packed)).not.toContain(TOKEN);
      }
      expect(u.search).not.toContain(TOKEN);
    }
    // The pairing link has it, after the #, which browsers never send.
    expect(links[0]!.split('#')[0]).not.toContain(payload);
    expect(decodePairing(links[0]!)).toMatchObject({ pairing: { token: TOKEN, relay: 'wss://ops-tunnel.trycloudflare.com' } });
  });
});

describe('a hosts list may name the relay, never its token', () => {
  it('the address goes with the list and back; the token never', async () => {
    const h = addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    await setRelaySettings({ url: 'wss://relay.example.net', token: TOKEN });
    const link = hostsLink([h], false, 'wss://relay.example.net');
    const file = hostsJson([h], false, 'wss://relay.example.net');
    expect(readHosts(link)).toEqual({ hosts: [expect.objectContaining({ name: 'web-1' })], relay: 'wss://relay.example.net' });
    expect(readHosts(file)).toMatchObject({ relay: 'wss://relay.example.net' });
    expect(file).not.toContain(TOKEN);
    expect(JSON.stringify(readHosts(link))).not.toContain(TOKEN);
    // An address that isn't a relay's is dropped, not offered.
    expect(readHosts(hostsJson([h], false, 'javascript:alert(1)'))).toEqual({ hosts: [expect.objectContaining({ name: 'web-1' })] });
  });
});

describe('the web container’s runtime configuration', () => {
  it('reads /config.json once; invalid values are left out', async () => {
    expect(parseRuntimeConfig({ publicUrl: 'https://Runbooks.Example.net/', library: '/sop/' })).toEqual({
      publicUrl: 'https://runbooks.example.net',
      library: '/sop/',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseRuntimeConfig({ publicUrl: 'http://evil.example.net', library: '/../etc/' })).toEqual({});
    expect(parseRuntimeConfig({ library: '/.git/' })).toEqual({});
    expect(parseRuntimeConfig('nope')).toEqual({});

    onTheWeb('http://localhost:8080');
    resetRuntimeConfig();
    const seen: string[] = [];
    const fetcher = server({ 'http://localhost:8080/config.json': { publicUrl: PUBLIC, library: '/sop/' } }, seen);
    await loadRuntimeConfig(fetcher);
    await loadRuntimeConfig(fetcher);
    expect(seen).toEqual(['http://localhost:8080/config.json']);
    expect(runtimeConfig()).toEqual({ publicUrl: PUBLIC, library: '/sop/' });
    // The library folder: the web app's default library.
    expect(defaultLibraryBase()).toBe('http://localhost:8080/sop/');
    // The public address: links start with it.
    expect(publicBaseOf()).toEqual({ base: PUBLIC, source: 'container' });
    expect(openLinkBase()).toBe(`${PUBLIC}/open`);
  });

  it('none (GitHub Pages answers with the app’s page): the page’s origin and /runbooks/', async () => {
    onTheWeb('https://app.example.net');
    resetRuntimeConfig();
    await loadRuntimeConfig(server({ 'https://app.example.net/config.json': '<!doctype html><html></html>' }));
    expect(runtimeConfig()).toEqual({});
    expect(defaultLibraryBase()).toBe('https://app.example.net/runbooks/');
    expect(publicBaseOf()).toEqual({ base: 'https://app.example.net', source: 'page' });
  });

  it('the public address: the setting over the container’s over the page’s; addresses on the page’s origin follow it', () => {
    onTheWeb('http://localhost:8080');
    expect(publicBaseOf()).toEqual({ base: 'http://localhost:8080', source: 'page' });
    // An http page: QR codes keep the app's own links (http links are not runbook links).
    expect(openLinkBase()).toBe('mdrunbook://open');
    resetRuntimeConfig({ publicUrl: 'https://from-env.example.net' });
    setPublicUrl(PUBLIC);
    expect(publicBaseOf()).toEqual({ base: PUBLIC, source: 'setting' });
    expect(toPublicUrl('http://localhost:8080/runbooks/a.md')).toBe(`${PUBLIC}/runbooks/a.md`);
    expect(toPublicUrl('https://elsewhere.example.net/a.md')).toBe('https://elsewhere.example.net/a.md');
    expect(fromPublicUrl(`${PUBLIC}/runbooks/a.md`)).toBe('http://localhost:8080/runbooks/a.md');
    expect(toPublicRelayUrl('ws://localhost:8080')).toBe('wss://ops-tunnel.trycloudflare.com');
    expect(toPublicRelayUrl('wss://relay.example.net')).toBe('wss://relay.example.net');
  });
});

describe('Show QR Code: a link to the runbook’s address', () => {
  const LIB = 'http://localhost:8080/runbooks/';

  it('a library copy links to its file at the public address, pinned with the sha256 of its text without outputs', async () => {
    onTheWeb('http://localhost:8080');
    setPublicUrl(PUBLIC);
    const fetcher = server({ [LIB + 'index.json']: '["restart.md"]', [LIB + 'restart.md']: RUNBOOK });
    await refreshLibrary({ fetcher, force: true });
    const lib = libraryState().library!;
    const opened = await openLibraryRunbook(lib, lib.entries[0]!);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    // It ran: outputs are not part of the pin.
    const ran = RUNBOOK.replace(
      '```\n',
      '```\n\n<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n',
    );
    updateRunbookText(opened.runbook.id, ran);
    expect(clearOutputBlocks(ran)).toBe(RUNBOOK);
    const copy = getRunbook(opened.runbook.id)!;
    const address = runbookAddress(copy, libraryState());
    expect(address).toEqual({ url: `${PUBLIC}/runbooks/restart.md`, sha256: runbookDigest(RUNBOOK) });
    const link = qrLink(copy, address as { url: string; sha256: string }, { host: 'web-1', params: { SERVICE: 'api' } });
    expect(link).toBe(
      `${PUBLIC}/open?url=${encodeURIComponent(`${PUBLIC}/runbooks/restart.md`)}&sha256=${runbookDigest(RUNBOOK)}&host=web-1&p.SERVICE=api`,
    );
    // Small, whatever the runbook's size.
    expect(link.length).toBeLessThan(300);
    // Edited: no longer the text at the address.
    updateRunbookText(copy.id, RUNBOOK + '\nMore.\n');
    expect(runbookAddress(getRunbook(copy.id)!, libraryState())).toEqual({ problem: 'edited' });
  });

  it('an url= link’s copy links back there; a runbook with no address travels in the code (rb=)', () => {
    const fromLink = addRunbook('restart.md', RUNBOOK, undefined, linkKey('https://x.example.net/restart.md', RUNBOOK));
    expect(runbookAddress(fromLink, libraryState())).toEqual({ url: 'https://x.example.net/restart.md', sha256: runbookDigest(RUNBOOK) });
    const carried = addRunbook('restart.md', RUNBOOK, undefined, linkKey('rb', RUNBOOK));
    expect(runbookAddress(carried, libraryState())).toBeUndefined();
    const local = addRunbook('restart.md', RUNBOOK);
    expect(runbookAddress(local, libraryState())).toBeUndefined();
    const parsed = parseRunbookLink(qrLink(local, undefined, { params: {} }));
    expect(parsed.ok && parsed.link.text).toBe(RUNBOOK);
  });

  it('a library on an http address with no https public address can’t be linked to', async () => {
    onTheWeb('http://localhost:8080');
    const fetcher = server({ [LIB + 'index.json']: '["restart.md"]', [LIB + 'restart.md']: RUNBOOK });
    await refreshLibrary({ fetcher, force: true });
    const lib = libraryState().library!;
    const opened = await openLibraryRunbook(lib, lib.entries[0]!);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    expect(runbookAddress(opened.runbook, libraryState())).toEqual({ problem: 'https' });
  });
});

describe('a runbook link into the team library', () => {
  const LIB = 'https://runbooks.example.net/sop/';
  const URL_ = LIB + 'restart.md';

  it('opens THE library copy, with its outputs, and the link’s parameters and host', async () => {
    setLibraryUrl(LIB);
    addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    const fetcher = server({ [LIB + 'index.json']: '["restart.md"]', [URL_]: RUNBOOK });
    expect(libraryTarget(URL_)).toEqual({ base: LIB, path: 'restart.md' });
    expect(libraryTarget('https://runbooks.example.net/other/restart.md')).toBeUndefined();
    expect(libraryTarget(LIB + '../restart.md')).toBeUndefined();

    // The first link makes the library copy (not a copy of its own).
    const first = await openRunbookLink(formatRunbookLink({ url: URL_, params: {} }), fetcher);
    if (first.kind !== 'opened') throw new Error(first.message);
    expect(first.runbook.source).toBe('library');
    expect(first.runbook.library).toMatchObject({ base: LIB, path: 'restart.md' });
    updateRunbookText(first.runbook.id, RUNBOOK + '\n<!-- kept -->\n');

    const link = formatRunbookLink({ url: URL_, sha256: runbookDigest(RUNBOOK), host: 'web-1', params: { SERVICE: 'api', NOPE: 'x' } });
    const again = await openRunbookLink(link, fetcher);
    if (again.kind !== 'opened') throw new Error(again.message);
    expect(again.runbook.id).toBe(first.runbook.id);
    expect(getRunbook(again.runbook.id)!.text).toContain('<!-- kept -->');
    expect(paramValues(again.runbook.id)).toMatchObject({ SERVICE: 'api' });
    expect(linkContext(again.runbook.id)).toMatchObject({ trust: 'pinned', hostId: expect.any(String), ignoredParams: ['NOPE'] });
    // One copy, however often the link is opened.
    const { result } = await renderHookRunbooks();
    expect(result.filter((r) => r.library?.path === 'restart.md')).toHaveLength(1);
  });

  it('the pin is checked against the library’s file; Only signed links still holds', async () => {
    setLibraryUrl(LIB);
    const fetcher = server({ [LIB + 'index.json']: '["restart.md"]', [URL_]: RUNBOOK });
    const wrong = formatRunbookLink({ url: URL_, sha256: runbookDigest('# Another\n'), params: {} });
    expect(await openRunbookLink(wrong, fetcher)).toMatchObject({ kind: 'error' });
    setOutputSetting('signedLinksOnly', true);
    expect(await openRunbookLink(formatRunbookLink({ url: URL_, params: {} }), fetcher)).toMatchObject({ kind: 'error' });
  });

  it('a library that opens verified runbooks only refuses an unsigned one, also through a link; no copy is made', async () => {
    setLibraryUrl(LIB);
    const seen: string[] = [];
    const fetcher = server({ [LIB + 'index.json']: { signedOnly: true, runbooks: ['restart.md'] }, [URL_]: RUNBOOK }, seen);
    const r = await openRunbookLink(formatRunbookLink({ url: URL_, sha256: runbookDigest(RUNBOOK), params: {} }), fetcher);
    expect(r).toMatchObject({ kind: 'error', message: expect.stringMatching(/sign/i) });
    const { result } = await renderHookRunbooks();
    expect(result.some((x) => x.source !== 'bundled')).toBe(false);
    // A file the library doesn't list: refused too (not opened as a copy of its own).
    const unlisted = server({ [LIB + 'index.json']: { signedOnly: true, runbooks: ['restart.md'] }, [LIB + 'unlisted.md']: RUNBOOK });
    const other = await openRunbookLink(formatRunbookLink({ url: LIB + 'unlisted.md', params: {} }), unlisted);
    expect(other).toMatchObject({ kind: 'error', message: expect.stringMatching(/not listed/) });
  });

  it('the library unreadable: a signedOnly library refuses, another opens the link as before', async () => {
    setLibraryUrl(LIB);
    // Read once, asking for signedOnly: the app remembers that.
    await refreshLibrary({ fetcher: server({ [LIB + 'index.json']: { signedOnly: true, runbooks: [] } }), force: true });
    await new Promise((r) => setTimeout(r, 0));
    // A new start, the library unreachable (the runbook's own address still answers).
    resetLibrary();
    const down = (async (url: string) => {
      if (url === URL_) return { ok: true, status: 200, url, headers: new Headers(), text: async () => RUNBOOK };
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await openRunbookLink(formatRunbookLink({ url: URL_, params: {} }), down)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/verified runbooks only/),
    });
    // A library that never asked for signedOnly, unreadable: the link opens a copy of its own, as any link.
    resetLibrary();
    await AsyncStorage.clear();
    expect(await openRunbookLink(formatRunbookLink({ url: URL_, params: {} }), down)).toMatchObject({
      kind: 'opened',
      runbook: { source: 'file' },
    });
  });
});

/** The runbooks as the list sees them. */
async function renderHookRunbooks(): Promise<{ result: ReturnType<typeof useRunbooks> }> {
  const out: { result: ReturnType<typeof useRunbooks> } = { result: [] };
  function Probe() {
    out.result = useRunbooks();
    return null;
  }
  await render(<Probe />);
  return out;
}

describe('the screens', () => {
  it('Pair a device: a code with the relay (and the hosts when ticked), a warning, hidden after a minute; Copy pairing link', async () => {
    jest.useFakeTimers();
    try {
      await setRelaySettings({ url: 'wss://relay.example.net', token: TOKEN });
      addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
      onTheWeb(PUBLIC);
      await render(<PairDeviceCard onClose={() => undefined} />);
      await waitFor(() => expect(screen.getByTestId('pair-code')).toBeTruthy());
      expect(screen.getByTestId('pair-warning')).toHaveTextContent(/secret/);
      await act(async () => {
        fireEvent(screen.getByTestId('pair-with-hosts'), 'valueChange', true);
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('pair-copy-link'));
      });
      const copied = jest.mocked(Clipboard.setStringAsync).mock.calls.at(-1)![0];
      expect(copied.startsWith(`${PUBLIC}/pair#${PAIR_PREFIX}`)).toBe(true);
      expect(new URL(copied).search).toBe('');
      expect(decodePairing(copied)).toMatchObject({
        pairing: { relay: 'wss://relay.example.net', token: TOKEN, hosts: [{ name: 'web-1' }] },
      });
      expect(screen.getByTestId('pair-link-copied')).toHaveTextContent(/token/);
      await act(async () => {
        jest.advanceTimersByTime(PAIR_SHOW_MS + 10);
      });
      expect(screen.queryByTestId('pair-code')).toBeNull();
      await act(async () => {
        fireEvent.press(screen.getByTestId('pair-show-again'));
      });
      expect(screen.getByTestId('pair-code')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Pair a device: the signers name each library at the public address, also when it changes while the card is open', async () => {
    await setRelaySettings({ url: 'wss://relay.example.net', token: TOKEN });
    onTheWeb('https://runbook.lab.example');
    await loadTrustedSigners();
    trustSigners(
      [{ principals: ['ops@lab.example'], keyType: 'ssh-ed25519', key: 'AAAA', fingerprint: FP_A }],
      'https://runbook.lab.example/runbooks/',
    );
    await render(<PairDeviceCard onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('pair-with-signers')).toBeTruthy());
    const signersInLink = async (): Promise<unknown> => {
      await act(async () => {
        fireEvent.press(screen.getByTestId('pair-copy-link'));
      });
      const read = decodePairing(jest.mocked(Clipboard.setStringAsync).mock.calls.at(-1)![0]);
      return 'pairing' in read ? read.pairing.signers : read;
    };
    expect(await signersInLink()).toEqual([{ library: 'https://runbook.lab.example/runbooks/', fingerprints: [FP_A] }]);
    // The user sets the public address (a tunnel) with the card open: the next code names it.
    await act(async () => setPublicUrl(PUBLIC));
    expect(await signersInLink()).toEqual([{ library: PUBLIC + '/runbooks/', fingerprints: [FP_A] }]);
  });

  it('Pair a device without a relay set up: says what to do first', async () => {
    await render(<PairDeviceCard onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('pair-needs-relay')).toBeTruthy());
    expect(screen.queryByTestId('pair-code')).toBeNull();
  });

  it('the phone: asks first; sets up the relay and the hosts (their keys only when ticked); then shows its own key', async () => {
    const payload = encodePairing({
      relay: 'wss://ops.example.net',
      token: TOKEN,
      hosts: [{ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy', hostKey: 'ecdsa-sha2-nistp256 AAAAkey=' }],
    });
    setPendingPairing(payload, 'code');
    await render(<PairScreen />);
    expect(screen.getByText('Set up the relay from this code?')).toBeTruthy();
    expect(await getRelaySettings()).toBeUndefined();
    await act(async () => {
      fireEvent.press(screen.getByTestId('pair-go'));
    });
    await waitFor(() => expect(screen.getByTestId('pair-done')).toBeTruthy());
    expect(await getRelaySettings()).toEqual({ url: 'wss://ops.example.net', token: TOKEN });
    expect(getHosts().map((h) => [h.name, h.hostKey])).toEqual([['web-1', undefined]]);
    expect(pendingPairing()).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('device-public-key')).toHaveTextContent(/^ecdsa-sha2-nistp256 .* md-runbook-app$/));
    expect(screen.getByText('Add this key to the server’s authorized_keys')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('device-key-qr'));
    });
    expect(screen.getByTestId('device-key-code')).toBeTruthy();
  });

  it('the phone: the other device’s signers are shown, and Not now keeps nothing', async () => {
    const signers = [{ library: 'https://lib.example.net/team/', fingerprints: [FP_A] }];
    setPendingPairing(encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, signers }), 'link');
    await render(<PairScreen />);
    expect(screen.getByTestId('pair-signers')).toHaveTextContent(
      /signers your other device trusts for 1 library.*never trusted by themselves/,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('pair-not-now'));
    });
    expect(signerHintFor('https://lib.example.net/team/')).toBeUndefined();
  });

  it('the phone: on Set up the other device’s signers are kept, and trust nothing', async () => {
    const signers = [{ library: 'https://lib.example.net/team/', fingerprints: [FP_A] }];
    setPendingPairing(encodePairing({ relay: 'wss://ops.example.net', token: TOKEN, signers }), 'link');
    await render(<PairScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('pair-go'));
    });
    await waitFor(() => expect(screen.getByTestId('pair-done')).toBeTruthy());
    expect(signerHintFor('https://lib.example.net/team/')).toMatchObject({ fingerprints: [FP_A] });
    expect(trustedSigners()).toEqual([]);
  });

  it('the phone, from a link: Not now sets up nothing; a damaged link says so', async () => {
    setPendingPairing(encodePairing({ relay: 'wss://ops.example.net', token: TOKEN }), 'link');
    await render(<PairScreen />);
    expect(screen.getByText('Set up the relay from this link?')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('pair-not-now'));
    });
    expect(screen.getByTestId('pair-declined')).toBeTruthy();
    expect(await getRelaySettings()).toBeUndefined();
    screen.unmount();
    setPendingPairing(PAIR_PREFIX + 'AAAA', 'link');
    await render(<PairScreen />);
    expect(screen.getByTestId('pair-problem')).toHaveTextContent(/damaged/);
  });
});

describe('the pairing token leaves the route too', () => {
  // Expo Router keeps a URL's fragment as the `#` param and writes it back into the address bar:
  // the pair screen replaces the route when it still carries one (the web smoke test checks the
  // address bar in a real browser).
  it('a pairing fragment, in the route or the address bar, is one to drop; any other is not', () => {
    const payload = encodePairing({ relay: 'wss://ops.example.net', token: TOKEN });
    expect(pairingFragmentInRoute(payload)).toBe(true);
    expect(pairingFragmentInRoute(undefined, '#' + payload)).toBe(true);
    expect(pairingFragmentInRoute('section-2', '#section-2')).toBe(false);
    expect(pairingFragmentInRoute(undefined, '')).toBe(false);
    expect(pairingFragmentInRoute(['x'])).toBe(false);
  });
});

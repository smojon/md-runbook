/**
 * Tokens never follow a redirect (net/noRedirect.ts): an answer that shows one is refused, and no
 * config of ours swaps expo/fetch (which honours `redirect: 'error'`) for React Native's fetch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redirectedTo } from '../net/noRedirect';

const ASKED = 'https://runbooks.example.net/v1/devices';

describe('redirectedTo', () => {
  it('names the host an answer came from when it was redirected', () => {
    expect(redirectedTo(ASKED, { status: 201 })).toBeUndefined();
    expect(redirectedTo(ASKED, { status: 201, url: ASKED })).toBeUndefined();
    expect(redirectedTo(ASKED, { status: 201, url: 'https://elsewhere.example.org/v1/devices' })).toBe('elsewhere.example.org');
    expect(redirectedTo(ASKED, { status: 201, url: 'https://runbooks.example.net/other' })).toBe('runbooks.example.net');
    expect(redirectedTo(ASKED, { status: 200, redirected: true })).toBe('runbooks.example.net');
    expect(redirectedTo(ASKED, { status: 302 })).toBe('runbooks.example.net');
  });
});

describe('the global fetch stays expo/fetch', () => {
  it('no config sets EXPO_PUBLIC_USE_RN_FETCH (React Native’s fetch follows redirects with the token)', () => {
    const root = join(__dirname, '..', '..');
    const files = ['app.config.js', 'app.json', 'eas.json', 'metro.config.js', ...readdirSync(root).filter((f) => f.startsWith('.env'))];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue;
      }
      expect({ f, set: text.includes('EXPO_PUBLIC_USE_RN_FETCH') }).toEqual({ f, set: false });
    }
  });
});

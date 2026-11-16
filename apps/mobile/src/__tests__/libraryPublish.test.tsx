/**
 * Publish to Library… and Remove from Library…, as VS Code's: only a runbook signed as a whole and
 * unchanged goes in (else Sign Runbook is offered), its path ends with the signed name, the upload
 * token is kept per server in secure storage and sent only in the Authorization header; Remove is
 * its own confirmation; refusals (401, 403, 404, 405) say what to do.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { generateKey } from '@md-runbook/ssh';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { refreshLibrary, resetLibrary } from '../runbooks/library';
import {
  defaultPath,
  libraryServer,
  pathProblem,
  publishCheck,
  rememberPublished,
  sendToLibrary,
  storeToken,
  tokenKey,
} from '../runbooks/libraryPublish';
import { addRunbook, resetRunbooks, useRunbooks } from '../runbooks/store';
import { LibraryPublishSettings } from '../screens/LibraryPublishSettings';
import { LibrarySection } from '../screens/LibrarySection';
import { RunbookView } from '../screens/RunbookView';
import { resetSettings, setLibraryServer, setLibraryUrl } from '../settings/store';
import { signPlan, signRunbook } from '../signing/sign';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
jest.mock('../ssh/appKey', () => ({ appKey: async () => undefined }));

const LIB = 'https://runbooks.example.net/runbooks/';
const SERVER = 'https://runbooks.example.net';
const TOKEN = 'tok-0123456789abcdefghijklmnop';
const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart api\n```\n';
let key: KeyPair;

async function signed(text = RUNBOOK): Promise<string> {
  const r = await signRunbook(
    text,
    signPlan(text, 'restart-api.md'),
    { name: 'restart-api', scopes: '', days: '', patterns: {} },
    'ana@example.net',
    key,
  );
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.text;
}

const fetchMock = jest.fn();
const answer = (status: number, body: unknown) => ({ status, url: undefined, text: async () => JSON.stringify(body) });
const press = async (id: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};
const type = async (id: string, text: string): Promise<void> => {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId(id), text);
  });
};
const more = async (id: string): Promise<void> => {
  await press('more-actions');
  await press(`action-${id}`);
};

beforeAll(async () => {
  key = await generateKey();
});
beforeEach(async () => {
  await AsyncStorage.clear();
  await SecureStore.deleteItemAsync(tokenKey(SERVER));
  resetRunbooks();
  resetSettings();
  resetLibrary();
  fetchMock.mockReset();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

describe('publishing (the logic)', () => {
  it('takes only a runbook signed as a whole, unchanged and unexpired', async () => {
    expect(publishCheck(RUNBOOK)).toEqual({ ok: false, why: 'unsigned' });
    const text = await signed();
    const ok = publishCheck(text);
    expect(ok.ok && ok.manifest.name).toBe('restart-api');
    expect(publishCheck(text.replace('Restart the API', 'Restart it'))).toMatchObject({ ok: false, why: 'changed' });
    expect(publishCheck(text, '2999-01-01')).toMatchObject({ ok: true });
  });

  it('the server: the setting, else the origin of the library the app reads; https only', () => {
    expect(libraryServer()).toBeUndefined();
    setLibraryUrl(LIB);
    expect(libraryServer()).toBe(SERVER);
    setLibraryServer('https://publish.example.net/');
    expect(libraryServer()).toBe('https://publish.example.net');
    setLibraryServer('http://publish.example.net');
    expect(libraryServer()).toBeUndefined();
  });

  it('the path ends with the signed name; the last one published is offered next time', async () => {
    expect(pathProblem('ops/restart-api.md', 'restart-api')).toBeUndefined();
    expect(pathProblem('ops/other.md', 'restart-api')).toBe('The path must end with the signed name: restart-api.md');
    expect(pathProblem('../x.md', undefined)).toBeTruthy();
    expect(await defaultPath({ id: 'r1' }, SERVER, 'restart-api')).toBe('restart-api.md');
    await rememberPublished('r1', 'ops/restart-api.md');
    expect(await defaultPath({ id: 'r1' }, SERVER, 'restart-api')).toBe('ops/restart-api.md');
  });

  it('sends the token in the Authorization header only, never following a redirect', async () => {
    fetchMock.mockResolvedValue(answer(201, { name: 'restart-api', version: 1 }));
    const r = await sendToLibrary({ method: 'POST', server: SERVER, path: 'ops/restart api.md', token: TOKEN, text: 'x' });
    expect(r).toEqual({ kind: 'answer', status: 201, answer: { name: 'restart-api', version: 1 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/v1/library/runbooks/ops/restart%20api.md`);
    expect(init).toMatchObject({ method: 'POST', body: 'x', redirect: 'error' });
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, 'content-type': 'text/markdown; charset=utf-8' });
    expect(url).not.toContain(TOKEN);
    // A runtime that followed a redirect anyway: not the server's answer.
    fetchMock.mockResolvedValue({ status: 200, url: 'https://elsewhere.example.org/x', text: async () => '{}' });
    expect(await sendToLibrary({ method: 'DELETE', server: SERVER, path: 'a.md', token: TOKEN })).toMatchObject({ kind: 'unreachable' });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await sendToLibrary({ method: 'DELETE', server: SERVER, path: 'a.md', token: TOKEN })).toEqual({
      kind: 'unreachable',
      why: 'offline',
    });
  });
});

describe('⋯ More → Share → Publish to Library…', () => {
  it('an unsigned runbook gets Sign Runbook first', async () => {
    setLibraryUrl(LIB);
    const r = addRunbook('restart-api.md', RUNBOOK);
    await render(<RunbookView id={r.id} />);
    await more('publishToLibrary');
    expect(screen.getByTestId('publish-not-signed')).toHaveTextContent(/This runbook is not signed/);
    await press('publish-sign');
    expect(screen.getByTestId('sign-card')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for the token once, publishes, and asks again when the server refuses it', async () => {
    setLibraryUrl(LIB);
    const r = addRunbook('restart-api.md', await signed());
    await render(<RunbookView id={r.id} />);
    await more('publishToLibrary');
    expect(screen.getByTestId('publish-form')).toHaveTextContent(/Publish restart-api version 1 to runbooks\.example\.net/);
    await waitFor(() => expect(screen.getByTestId('publish-path').props.value).toBe('restart-api.md'));
    expect(screen.getByTestId('publish-form')).toHaveTextContent(/Kept in this device’s secure storage/);
    await type('publish-path', 'ops/other.md');
    expect(screen.getByTestId('publish-path-problem')).toHaveTextContent(/signed name: restart-api.md/);
    await type('publish-path', 'ops/restart-api.md');
    await type('publish-token', TOKEN);
    fetchMock.mockResolvedValue(answer(201, { name: 'restart-api', version: 1, signer: 'ana@example.net' }));
    await press('publish-go');
    await waitFor(() =>
      expect(screen.getByTestId('publish-result')).toHaveTextContent(/Published restart-api version 1 at ops\/restart-api\.md/),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(`${SERVER}/v1/library/runbooks/ops/restart-api.md`);
    expect(await SecureStore.getItemAsync(tokenKey(SERVER))).toBe(TOKEN);
    await press('publish-cancel');

    // Next time: the stored token, the path published last; a refused token is asked for again.
    await more('publishToLibrary');
    await waitFor(() => expect(screen.getByTestId('publish-path').props.value).toBe('ops/restart-api.md'));
    expect(screen.queryByTestId('publish-token')).toBeNull();
    fetchMock.mockResolvedValue(answer(401, { error: 'unknown token' }));
    await press('publish-go');
    await waitFor(() => expect(screen.getByTestId('publish-result')).toHaveTextContent(/refused the upload token/));
    expect(screen.getByTestId('publish-token')).toBeTruthy();
  });

  it('says where to set the server when there is none', async () => {
    const r = addRunbook('restart-api.md', await signed());
    await render(<RunbookView id={r.id} />);
    await more('publishToLibrary');
    expect(screen.getByTestId('publish-no-server')).toHaveTextContent(/No library server set/);
  });
});

describe('Remove from Library…', () => {
  it('is its own confirmation; a server that doesn’t allow it says how to turn it on', async () => {
    setLibraryUrl(LIB);
    await storeToken(SERVER, TOKEN);
    const r = addRunbook('restart-api.md', await signed());
    await render(<RunbookView id={r.id} />);
    await more('removeFromLibrary');
    expect(screen.getByTestId('remove-form')).toHaveTextContent(/Remove from the team library at runbooks\.example\.net\?/);
    expect(screen.getByTestId('remove-form')).toHaveTextContent(/Copies people opened stay theirs/);
    await waitFor(() => expect(screen.getByTestId('publish-path').props.value).toBe('restart-api.md'));
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(answer(405, { error: 'deleting is off' }));
    await press('remove-go');
    await waitFor(() => expect(screen.getByTestId('publish-result')).toHaveTextContent(/LIBRARY_ALLOW_DELETE=true/));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    fetchMock.mockResolvedValue(answer(200, { deleted: 'restart-api.md', version: 1 }));
    await press('remove-go');
    await waitFor(() =>
      expect(screen.getByTestId('publish-result')).toHaveTextContent('Removed restart-api.md (version 1) from the library.'),
    );
  });

  it('from a Team runbooks row’s ⋯, with its path', async () => {
    setLibraryUrl(LIB);
    await storeToken(SERVER, TOKEN);
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ runbooks: ['ops/restart-api.md'] }),
      [LIB + 'ops/restart-api.md']: RUNBOOK,
    };
    const fetcher = (async (url: string) =>
      files[url] === undefined
        ? { ok: false, status: 404, url, headers: new Headers(), text: async () => '' }
        : { ok: true, status: 200, url, headers: new Headers(), text: async () => files[url] }) as unknown as typeof fetch;
    await refreshLibrary({ fetcher, force: true });
    function Copies() {
      useRunbooks();
      return <LibrarySection />;
    }
    await render(<Copies />);
    await press('library-actions-ops/restart-api.md');
    // Publish needs your copy: shown, with why not.
    expect(screen.getByTestId('action-publishToLibrary')).toHaveTextContent(/Open it first/);
    await press('action-removeFromLibrary');
    await waitFor(() => expect(screen.getByTestId('publish-path').props.value).toBe('ops/restart-api.md'));
    fetchMock.mockResolvedValue(answer(404, { error: 'ops/restart-api.md is not in the library' }));
    await press('remove-go');
    await waitFor(() => expect(screen.getByTestId('publish-result')).toHaveTextContent('ops/restart-api.md is not in the library.'));
  });
});

describe('Hosts & settings → Publishing to the library', () => {
  it('shows the server used, and sets and forgets its token', async () => {
    setLibraryUrl(LIB);
    await render(<LibraryPublishSettings />);
    expect(screen.getByTestId('publish-server-now')).toHaveTextContent(`Used now: ${SERVER}`);
    await type('publish-server', 'http://publish.example.net');
    expect(screen.getByTestId('publish-server-problem')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('publish-token-state')).toHaveTextContent('No upload token for runbooks.example.net yet.'),
    );
    await press('publish-token-set');
    await type('publish-token-input', TOKEN);
    await press('publish-token-save');
    await waitFor(() =>
      expect(screen.getByTestId('publish-token-state')).toHaveTextContent('An upload token for runbooks.example.net is stored.'),
    );
    expect(await SecureStore.getItemAsync(tokenKey(SERVER))).toBe(TOKEN);
    await press('publish-token-forget');
    await waitFor(() => expect(screen.getByTestId('publish-token-said')).toHaveTextContent('Token forgotten.'));
    expect(await SecureStore.getItemAsync(tokenKey(SERVER))).toBeNull();
  });
});

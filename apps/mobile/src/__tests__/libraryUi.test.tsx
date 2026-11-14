import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { allowedSignersLine, generateKey } from '@md-runbook/ssh';
import { defaultLibraryBase, libraryBase, libraryLink, libraryLinkUrl, refreshLibrary, resetLibrary } from '../runbooks/library';
import { getRunbook, resetRunbooks, updateRunbookText, useRunbooks } from '../runbooks/store';
import { libraryUrlSetting, resetSettings, setLibraryUrl } from '../settings/store';
import { resetTrustedSigners, trustedSigners } from '../signing/trust';
import { signPlan, signRunbook } from '../signing/sign';
import { LibraryAdd } from '../screens/LibraryAdd';
import { LibrarySection } from '../screens/LibrarySection';
import { LibrarySettings } from '../screens/LibrarySettings';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
}));

const LIB = 'https://runbooks.example.net/team/';
const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart api\n```\n';

function server(files: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const body = files[url];
    return body === undefined
      ? { ok: false, status: 404, headers: new Headers(), text: async () => '' }
      : { ok: true, status: 200, headers: new Headers(), text: async () => body };
  }) as unknown as typeof fetch;
}

async function press(id: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
}
async function type(id: string, text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId(id), text);
  });
}

/** The copies, as the list sees them (re-renders the section when they change). */
function Copies() {
  useRunbooks();
  return <LibrarySection />;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunbooks();
  resetSettings();
  resetTrustedSigners();
  resetLibrary();
  jest.mocked(router.push).mockClear();
  jest.mocked(router.replace).mockClear();
});

describe('the library address', () => {
  it('on the phones there is none until it is set; then the set address is read', async () => {
    expect(Platform.OS).not.toBe('web');
    expect(defaultLibraryBase()).toBeUndefined();
    expect(libraryBase()).toBeUndefined();
    setLibraryUrl('https://runbooks.example.net/team');
    expect(libraryBase()).toBe(LIB);
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    }) as unknown as typeof fetch;
    await refreshLibrary({ fetcher, force: true });
    expect(seen[0]).toBe(LIB + 'index.json');
    // An http address set by hand (not through the screen) is not read.
    setLibraryUrl('http://runbooks.example.net/team/');
    expect(libraryBase()).toBeUndefined();
  });

  it('on the web the default is the app’s own /runbooks/', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const g = globalThis as { location?: unknown };
    const before = g.location;
    g.location = { origin: 'https://app.example.net' };
    try {
      expect(defaultLibraryBase()).toBe('https://app.example.net/runbooks/');
      expect(libraryBase()).toBe('https://app.example.net/runbooks/');
      setLibraryUrl('https://other.example.net/r/');
      expect(libraryBase()).toBe('https://other.example.net/r/');
    } finally {
      g.location = before;
    }
  });

  it('the settings: https only, Check says how many runbooks or why not, Save and Remove', async () => {
    const fetcher = server({ [LIB + 'index.json']: '["a.md", "b.md"]', [LIB + 'a.md']: RUNBOOK, [LIB + 'b.md']: RUNBOOK });
    await render(<LibrarySettings fetcher={fetcher} />);
    await type('library-url', 'http://runbooks.example.net/team/');
    expect(screen.getByTestId('library-url-problem')).toHaveTextContent(/https/);
    expect(screen.getByTestId('library-save')).toBeDisabled();
    await type('library-url', 'https://runbooks.example.net/team');
    expect(screen.queryByTestId('library-url-problem')).toBeNull();
    await press('library-check');
    await waitFor(() => expect(screen.getByTestId('library-check-result')).toHaveTextContent('2 runbooks'));
    await type('library-url', 'https://nothing.example.net/');
    await press('library-check');
    await waitFor(() => expect(screen.getByTestId('library-check-result')).toHaveTextContent(/No library/));
    await type('library-url', 'https://runbooks.example.net/team');
    await press('library-save');
    expect(libraryUrlSetting()).toBe(LIB);
    // Shared as a QR code of the add link.
    await press('library-share');
    expect(screen.getByTestId('library-share-code')).toBeTruthy();
    await press('library-remove');
    expect(libraryUrlSetting()).toBe('');
  });
});

describe('adding a library by link or QR code', () => {
  it('links: the app’s own and the web app’s; others are not library links', () => {
    expect(libraryLinkUrl(libraryLink(LIB))).toBe(LIB);
    expect(libraryLinkUrl('https://app.example.net/library?url=https%3A%2F%2Fx.example.net%2Fr%2F')).toBe('https://x.example.net/r/');
    expect(libraryLinkUrl('mdrunbook://open?url=https%3A%2F%2Fx.example.net%2Fr.md')).toBeUndefined();
    expect(libraryLinkUrl('not a link')).toBeUndefined();
  });

  it('asks first, names the host, and adds it only on Add', async () => {
    await render(<LibraryAdd url="https://runbooks.example.net/team" />);
    expect(screen.getByTestId('library-add-prompt')).toHaveTextContent('Add the team library at runbooks.example.net?');
    expect(libraryUrlSetting()).toBe('');
    await press('library-add-go');
    expect(libraryUrlSetting()).toBe(LIB);
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('Cancel adds nothing; an http address is refused', async () => {
    const { unmount } = await render(<LibraryAdd url="https://runbooks.example.net/team/" />);
    await press('library-add-cancel');
    expect(libraryUrlSetting()).toBe('');
    await unmount();
    await render(<LibraryAdd url="http://runbooks.example.net/team/" />);
    expect(screen.getByTestId('library-add-error')).toHaveTextContent(/https/);
    expect(screen.queryByTestId('library-add-go')).toBeNull();
  });
});

describe('Team runbooks on the list', () => {
  it('nothing at all without a library', async () => {
    await refreshLibrary({ fetcher: server({}) });
    await render(<LibrarySection />);
    expect(screen.queryByTestId('library')).toBeNull();
    await act(async () => {
      setLibraryUrl(LIB);
      await refreshLibrary({ fetcher: server({}), force: true });
    });
    expect(screen.queryByTestId('library')).toBeNull();
  });

  it('lists the runbooks with their signatures; signers are trusted only after the prompt; opening makes a copy; Update', async () => {
    const alice = await generateKey();
    const signedR = await signRunbook(
      RUNBOOK,
      signPlan(RUNBOOK, 'r.md'),
      { name: 'r', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!signedR.ok) throw new Error('not signed');
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['ops/restart.md', { path: 'notes.md', title: 'Notes' }] }),
      [LIB + 'ops/restart.md']: signedR.text,
      [LIB + 'notes.md']: '# Notes\n\n```bash\necho hi\n```\n',
      [LIB + 'allowed_signers']: (await allowedSignersLine(alice, 'alice@example.net')) + '\n',
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    await render(<Copies />);
    await waitFor(() => expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent('Signed, unknown signer'));
    expect(screen.getByText('Team runbooks · ops')).toBeTruthy();
    expect(screen.getByTestId('library-sig-notes.md')).toHaveTextContent('Not signed');
    // signedOnly: the unsigned one can't be opened, and says why.
    expect(screen.getByTestId('library-why-notes.md')).toHaveTextContent(/signed runbooks only/);
    expect(screen.getByTestId('library-notes.md')).toBeDisabled();

    // The library's signers: shown with fingerprints, the server vouching for itself said, trusted on yes only.
    await press('library-trust');
    expect(screen.getByTestId('library-trust-prompt')).toHaveTextContent(/vouching for itself/);
    expect(screen.getByTestId('library-trust-prompt')).toHaveTextContent(/SHA256:/);
    expect(trustedSigners()).toHaveLength(0);
    await press('library-trust-go');
    expect(trustedSigners()).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent('Signed by alice@example.net, verified'),
    );

    // Opening makes the user's copy.
    await press('library-ops/restart.md');
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    const id = (jest.mocked(router.push).mock.calls[0]![0] as unknown as { params: { id: string } }).params.id;
    expect(getRunbook(id)).toMatchObject({ source: 'library', text: signedR.text });
    await waitFor(() => expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent(/Your copy/));

    // The library's file changes, unsigned now: Update available, and the update says the signature is gone.
    files[LIB + 'ops/restart.md'] = RUNBOOK + '\nMore.\n';
    files[LIB + 'index.json'] = JSON.stringify({ runbooks: ['ops/restart.md'] });
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    await press('library-update-go-ops/restart.md');
    await waitFor(() =>
      expect(screen.getByTestId('library-update-confirm-ops/restart.md')).toHaveTextContent(
        /not signed \(yours was signed by alice@example.net\)/,
      ),
    );
    expect(getRunbook(id)?.text).toBe(signedR.text);
    await press('library-update-anyway-ops/restart.md');
    await waitFor(() => expect(getRunbook(id)?.text).toBe(RUNBOOK + '\nMore.\n'));
    expect(screen.queryByTestId('library-update-ops/restart.md')).toBeNull();

    // Keep mine: the next version is skipped until another one comes.
    await act(async () => updateRunbookText(id, RUNBOOK + '\nMore.\n'));
    files[LIB + 'ops/restart.md'] = RUNBOOK + '\nEven more.\n';
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    await press('library-keep-ops/restart.md');
    expect(screen.queryByTestId('library-update-ops/restart.md')).toBeNull();
    expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent(/Newer version skipped/);
  });
});

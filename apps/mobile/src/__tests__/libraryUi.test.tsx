import { SIGNATURE_NAMESPACE, buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { allowedSignersLine, generateKey, signSshsig } from '@md-runbook/ssh';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import {
  defaultLibraryBase,
  libraryBase,
  libraryLink,
  libraryLinkUrl,
  libraryState,
  openLibraryRunbook,
  refreshLibrary,
  resetLibrary,
} from '../runbooks/library';
import { addHost, resetHosts } from '../hosts/store';
import { openTransport } from '../ssh/transport';
import { getRunbook, resetRunbooks, updateRunbookText, useRunbooks } from '../runbooks/store';
import { libraryUrlSetting, resetSettings, setLibraryUrl } from '../settings/store';
import { addSigners, parseAllowedSigners, resetTrustedSigners, trustSigners, trustedSigners } from '../signing/trust';
import { signPlan, signRunbook } from '../signing/sign';
import { LibraryAdd } from '../screens/LibraryAdd';
import { LibrarySection } from '../screens/LibrarySection';
import { LibrarySettings } from '../screens/LibrarySettings';
import { RunbookView } from '../screens/RunbookView';
import { TrustedSignersSection } from '../screens/TrustedSigners';
import { rememberSignerHints, resetSignerHints } from '../pairing/signerHints';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
jest.mock('../ssh/appKey', () => ({ appKey: async () => undefined }));

const LIB = 'https://runbooks.example.net/team/';
const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart api\n```\n';

function server(files: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const body = files[url];
    return body === undefined
      ? { ok: false, status: 404, url, headers: new Headers(), text: async () => '' }
      : { ok: true, status: 200, url, headers: new Headers(), text: async () => body };
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

/** Signed as before manifest version 2: the bash blocks only ("these steps verified"). */
async function signedV1(text: string, key: KeyPair, signer = 'alice@example.net'): Promise<string> {
  const built = buildManifest(text, { name: 'restart', version: 1, scopes: [], patterns: {} }, { version: 1 });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);
  return withSignature(text, { signer, signed: '2026-11-14', manifest, signature: await signSshsig(key, manifest) });
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
  resetSignerHints();
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

  it('a user name before the host is refused; the address shown is the one stored', async () => {
    const { unmount } = await render(<LibraryAdd url="https://runbooks.example.net@evil.example/team/" />);
    expect(screen.getByTestId('library-add-error')).toHaveTextContent(/user name or password/);
    expect(screen.queryByTestId('library-add-go')).toBeNull();
    await unmount();
    await render(<LibraryAdd url="HTTPS://Runbooks.Example.NET/team" />);
    expect(screen.getByTestId('library-add-prompt')).toHaveTextContent('Add the team library at runbooks.example.net?');
    expect(screen.getByText(/https:\/\/runbooks\.example\.net\/team\/ under Team runbooks/)).toBeTruthy();
    await press('library-add-go');
    expect(libraryUrlSetting()).toBe(LIB);
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
      signPlan(RUNBOOK, 'restart.md'),
      { name: 'restart', scopes: '', days: '', patterns: {} },
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
    expect(screen.getByTestId('library-facts-ops/restart.md')).toHaveTextContent('restart, version 1');
    expect(screen.getByText('Team runbooks · ops')).toBeTruthy();
    expect(screen.getByTestId('library-sig-notes.md')).toHaveTextContent('Not signed');
    // signedOnly: the unsigned one can't be opened, and says why; nor the signed one until its signer is trusted.
    expect(screen.getByTestId('library-why-notes.md')).toHaveTextContent(/verified runbooks only/);
    expect(screen.getByTestId('library-notes.md')).toBeDisabled();
    expect(screen.getByTestId('library-why-ops/restart.md')).toHaveTextContent(/trust its signers first/);

    // The library's signers: shown with fingerprints, the server vouching for itself said (as a list), for this library only, trusted on yes only.
    await press('library-trust');
    expect(screen.getByTestId('library-trust-prompt')).toHaveTextContent(
      /Trust these keys for the team library at runbooks\.example\.net\?/,
    );
    // One point per line (a phone shows them as a list, not a paragraph of 14 lines).
    expect(screen.getByTestId('library-trust-points').children).toHaveLength(5);
    expect(screen.getByTestId('library-trust-points')).toHaveTextContent(/It vouches for itself/);
    expect(screen.getByTestId('library-trust-points')).toHaveTextContent(/For this library only/);
    expect(screen.getByTestId('library-trust-prompt')).toHaveTextContent(/SHA256:/);
    expect(trustedSigners()).toHaveLength(0);
    await press('library-trust-go');
    expect(trustedSigners()).toEqual([expect.objectContaining({ from: LIB })]);
    await waitFor(() =>
      expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent('Signed by alice@example.net: whole runbook verified'),
    );

    // Opening makes the user's copy.
    await press('library-ops/restart.md');
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    const id = (jest.mocked(router.push).mock.calls[0]![0] as unknown as { params: { id: string } }).params.id;
    expect(getRunbook(id)).toMatchObject({ source: 'library', text: signedR.text });
    await waitFor(() => expect(screen.getByTestId('library-sig-ops/restart.md')).toHaveTextContent(/Your copy/));

    // The library's file changes, unsigned now, and index.json stops asking for signedOnly: the app keeps it on.
    files[LIB + 'ops/restart.md'] = RUNBOOK + '\nMore.\n';
    files[LIB + 'index.json'] = JSON.stringify({ runbooks: ['ops/restart.md'] });
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    expect(screen.getByTestId('library-signed-only-dropped')).toHaveTextContent(/Until you agree, the app still opens only those/);
    // An unsigned version is not offered while the library opens verified runbooks only: the row says why.
    await waitFor(() =>
      expect(screen.getByTestId('library-update-refused-ops/restart.md')).toHaveTextContent(/can't be taken.*not signed/),
    );
    expect(screen.queryByTestId('library-update-go-ops/restart.md')).toBeNull();
    expect(getRunbook(id)?.text).toBe(signedR.text);
    // The user agrees: Update available, and the update says the signature is gone.
    await press('library-allow-unverified');
    expect(screen.queryByTestId('library-signed-only-dropped')).toBeNull();
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

  it('the opened copy says what the list says: a PowerShell block outside a version 1 signature is partly signed in both', async () => {
    const alice = await generateKey();
    const v1 = await signedV1(RUNBOOK, alice);
    const signedR = await signRunbook(
      RUNBOOK,
      signPlan(RUNBOOK, 'restart.md'),
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!signedR.ok) throw new Error('not signed');
    const pwsh = (s: string): string =>
      s.replace('# Restart the API\n', '# Restart the API\n\n```powershell\nRemove-Item -Recurse C:\\data\n```\n');
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify(['restart.md', 'db.md', 'whole.md']),
      [LIB + 'restart.md']: pwsh(v1),
      [LIB + 'db.md']: v1,
      // Signed as a whole (version 2), then a PowerShell block added: changed, not partly signed.
      [LIB + 'whole.md']: pwsh(signedR.text),
      [LIB + 'allowed_signers']: (await allowedSignersLine(alice, 'alice@example.net')) + '\n',
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    await render(<Copies />);
    await press('library-trust');
    await press('library-trust-go');
    await waitFor(() =>
      expect(screen.getByTestId('library-sig-restart.md')).toHaveTextContent('Partly signed: 1 block that can run is not covered'),
    );
    // The same signed runbook served as db.md: verified, but under another name than the file's.
    await waitFor(() => expect(screen.getByTestId('library-sig-db.md')).toHaveTextContent(/these steps verified/));
    expect(screen.getByTestId('library-facts-db.md')).toHaveTextContent(/^restart, version 1 · signed under another name/);
    expect(screen.getByTestId('library-sig-whole.md')).toHaveTextContent('Changed since signing');
    await press('library-restart.md');
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    const id = (jest.mocked(router.push).mock.calls[0]![0] as unknown as { params: { id: string } }).params.id;
    await screen.unmount();
    await render(<RunbookView id={id} />);
    await waitFor(() =>
      expect(screen.getByTestId('signed-library-state')).toHaveTextContent('Partly signed: 1 block that can run is not covered'),
    );
    expect(screen.getByTestId('signed-outside')).toHaveTextContent(/PowerShell, cmd/);
    expect(screen.queryByTestId('signed-claim')).toBeNull();
  });

  it('a whole runbook signature: the banner says the whole runbook is verified, and nothing is partly signed', async () => {
    const alice = await generateKey();
    const text = RUNBOOK + '\n```powershell\nRestart-Service api\n```\n';
    const signedR = await signRunbook(
      text,
      signPlan(text, 'restart.md'),
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!signedR.ok) throw new Error('not signed');
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['restart.md'] }),
      [LIB + 'restart.md']: signedR.text,
      [LIB + 'allowed_signers']: (await allowedSignersLine(alice, 'alice@example.net')) + '\n',
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    const opened = await openLibraryRunbook(libraryState().library!, libraryState().library!.entries[0]!);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    await render(<RunbookView id={opened.runbook.id} />);
    await waitFor(() =>
      expect(screen.getByTestId('signed-library-state')).toHaveTextContent('Signed by alice@example.net: whole runbook verified'),
    );
    expect(screen.getByTestId('signed-coverage')).toHaveTextContent(/covers the whole runbook/);
    expect(screen.queryByTestId('signed-outside')).toBeNull();
    expect(screen.queryByTestId('signed-library-refused')).toBeNull();
  });
});

describe('a copy the library refuses (signedOnly): the recheck of 2026-11-14', () => {
  async function libraryWithCopy(): Promise<{ id: string; files: Record<string, string>; alice: KeyPair; text: string }> {
    const alice = await generateKey();
    const signedR = await signRunbook(
      RUNBOOK,
      signPlan(RUNBOOK, 'restart.md'),
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!signedR.ok) throw new Error('not signed');
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['restart.md'] }),
      [LIB + 'restart.md']: signedR.text,
      [LIB + 'allowed_signers']: (await allowedSignersLine(alice, 'alice@example.net')) + '\n',
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    const opened = await openLibraryRunbook(libraryState().library!, libraryState().library!.entries[0]!);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    return { id: opened.runbook.id, files, alice, text: signedR.text };
  }

  it('D: an edited copy runs nothing from the runbook screen and says why, also before the library is read', async () => {
    resetHosts();
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const { id } = await libraryWithCopy();
    // The user's own edit of a signed block: not verified any more.
    updateRunbookText(id, getRunbook(id)!.text.replace('systemctl restart api', 'systemctl restart api --now'));
    // A start offline: the library isn't read; the policy the app remembers holds.
    resetLibrary();
    await render(<RunbookView id={id} />);
    await waitFor(() => expect(screen.getByTestId('signed-library-refused')).toHaveTextContent(/changed since signing/));
    await press('cell-1-run');
    expect(screen.getByTestId('run-notice')).toHaveTextContent(/doesn’t run until verified again/);
    expect(openTransport).not.toHaveBeenCalled();
  });

  it('D: an unsigned copy gets a banner too', async () => {
    const { id } = await libraryWithCopy();
    updateRunbookText(id, RUNBOOK);
    await render(<RunbookView id={id} />);
    await waitFor(() => expect(screen.getByTestId('library-refused')).toHaveTextContent(/not signed/));
  });

  it('E: a refused copy is offered the library’s version, and Keep mine is not offered', async () => {
    const { id, files, alice } = await libraryWithCopy();
    // The library moves to version 2: the floor is 2, the copy (version 1) is refused from now on.
    const resigned = await signRunbook(
      RUNBOOK + '\nv2\n',
      { ...signPlan(RUNBOOK + '\nv2\n', 'restart.md'), version: 2 },
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!resigned.ok) throw new Error('not signed');
    files[LIB + 'restart.md'] = resigned.text;
    await render(<Copies />);
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    await waitFor(() => expect(screen.getByTestId('library-copy-why-restart.md')).toHaveTextContent(/older than version 2/));
    expect(screen.getByTestId('library-replace-restart.md')).toHaveTextContent('Replace with the library’s version');
    expect(screen.queryByTestId('library-keep-restart.md')).toBeNull();
    await press('library-replace-restart.md');
    await waitFor(() => expect(getRunbook(id)?.text).toBe(resigned.text));
    await waitFor(() => expect(screen.queryByTestId('library-copy-why-restart.md')).toBeNull());
  });

  it('F: a library version the library would refuse is not offered: changed since signing; the row says why', async () => {
    const { id, files, text } = await libraryWithCopy();
    files[LIB + 'restart.md'] = text.replace('# Restart the API', '# Restart the API now');
    await render(<Copies />);
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    await waitFor(() =>
      expect(screen.getByTestId('library-update-refused-restart.md')).toHaveTextContent(
        /The library's version can't be taken, so your copy stays as it is: .*changed since signing/i,
      ),
    );
    expect(screen.queryByTestId('library-update-go-restart.md')).toBeNull();
    expect(screen.queryByTestId('library-keep-restart.md')).toBeNull();
    expect(getRunbook(id)?.text).toBe(text);
  });

  it('F: nor a genuinely signed version older than one seen before', async () => {
    const { id, files, alice, text } = await libraryWithCopy();
    const v2 = await signRunbook(
      RUNBOOK + '\nv2\n',
      { ...signPlan(RUNBOOK + '\nv2\n', 'restart.md'), version: 2 },
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!v2.ok) throw new Error('not signed');
    files[LIB + 'restart.md'] = v2.text;
    await render(<Copies />);
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    // Offered once the library's version is checked.
    await waitFor(() => expect(screen.getByTestId('library-replace-restart.md')).toBeTruthy());
    await press('library-replace-restart.md');
    await waitFor(() => expect(getRunbook(id)?.text).toBe(v2.text));
    // The library goes back to version 1, still genuinely signed.
    files[LIB + 'restart.md'] = text;
    await act(() => refreshLibrary({ fetcher: server(files), force: true }));
    await waitFor(() => expect(screen.getByTestId('library-update-refused-restart.md')).toHaveTextContent(/older than version 2/));
    expect(screen.queryByTestId('library-update-go-restart.md')).toBeNull();
    expect(screen.queryByTestId('library-keep-restart.md')).toBeNull();
    expect(getRunbook(id)?.text).toBe(v2.text);
  });
});

describe('Trust these signers, compared with what your other device trusts (a pairing link)', () => {
  it('marks each key, says when the two differ, and trusts nothing by itself', async () => {
    const alice = await generateKey();
    const bob = await generateKey();
    const carol = await generateKey();
    const aliceLine = await allowedSignersLine(alice, 'alice@example.net');
    const bobLine = await allowedSignersLine(bob, 'bob@example.net');
    const fp = (line: string): string => parseAllowedSigners(line, SIGNATURE_NAMESPACE).signers[0]!.fingerprint;
    // The other device trusts alice and carol here; the library publishes alice and bob.
    rememberSignerHints([{ library: LIB, fingerprints: [fp(aliceLine), fp(await allowedSignersLine(carol, 'carol@example.net'))] }]);
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server({ [LIB + 'index.json']: '[]', [LIB + 'allowed_signers']: aliceLine + '\n' + bobLine + '\n' }) });
    await render(<Copies />);
    await press('library-trust');
    expect(screen.getByTestId('library-signers-other')).toHaveTextContent(
      'Not what your other device trusts for this library: 1 key here it doesn’t trust; 1 key it trusts is not published here. Check with the signers first.',
    );
    expect(screen.getAllByTestId('library-signer-other-yes')).toHaveLength(1);
    expect(screen.getAllByTestId('library-signer-other-no')).toHaveLength(1);
    expect(trustedSigners()).toHaveLength(0);
    await press('library-trust-cancel');
    expect(trustedSigners()).toHaveLength(0);
  });

  it('the same keys on both sides: said so; trusting is still the user’s press', async () => {
    const aliceLine = await allowedSignersLine(await generateKey(), 'alice@example.net');
    const bobLine = await allowedSignersLine(await generateKey(), 'bob@example.net');
    const fp = (line: string): string => parseAllowedSigners(line, SIGNATURE_NAMESPACE).signers[0]!.fingerprint;
    rememberSignerHints([{ library: LIB, fingerprints: [fp(aliceLine), fp(bobLine)] }]);
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server({ [LIB + 'index.json']: '[]', [LIB + 'allowed_signers']: aliceLine + '\n' + bobLine + '\n' }) });
    await render(<Copies />);
    await press('library-trust');
    expect(screen.getByTestId('library-signers-other')).toHaveTextContent('The same keys your other device trusts for this library.');
    expect(screen.getAllByTestId('library-signer-other-yes')).toHaveLength(2);
    expect(trustedSigners()).toHaveLength(0);
    await press('library-trust-go');
    expect(trustedSigners()).toHaveLength(2);
  });

  it('no hint for this library: the prompt is as before', async () => {
    const alice = await generateKey();
    const aliceLine = await allowedSignersLine(alice, 'alice@example.net');
    const fp = parseAllowedSigners(aliceLine, SIGNATURE_NAMESPACE).signers[0]!.fingerprint;
    rememberSignerHints([{ library: 'https://other.example.net/lib/', fingerprints: [fp] }]);
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server({ [LIB + 'index.json']: '[]', [LIB + 'allowed_signers']: aliceLine + '\n' }) });
    await render(<Copies />);
    await press('library-trust');
    expect(screen.queryByTestId('library-signers-other')).toBeNull();
    expect(screen.queryByTestId('library-signer-other-yes')).toBeNull();
  });
});

describe('Hosts & settings → Trusted signers', () => {
  it('lists each trusted key with the library it counts for, flags one the library dropped, and removes it', async () => {
    const alice = await generateKey();
    const bob = await generateKey();
    const aliceLine = await allowedSignersLine(alice, 'alice@example.net');
    const bobLine = (await allowedSignersLine(bob, 'x')).replace(/^x /, '*@example.net ');
    trustSigners(parseAllowedSigners(aliceLine + '\n' + bobLine, SIGNATURE_NAMESPACE).signers, LIB);
    trustSigners(parseAllowedSigners(aliceLine, SIGNATURE_NAMESPACE).signers, 'https://other.example.net/lib/');
    // The library now publishes alice only.
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server({ [LIB + 'index.json']: '[]', [LIB + 'allowed_signers']: aliceLine + '\n' }) });
    // One list for the team library and run reports alike, each entry with where it counts.
    addSigners((await allowedSignersLine(bob, 'ops@example.net')) + '\n');
    await render(<TrustedSignersSection />);
    expect(screen.getByTestId('trusted-signers')).toHaveTextContent(/Keys from a team library count for that library only/);
    expect(screen.getByTestId('trusted-signer-0')).toHaveTextContent(/alice@example.net/);
    expect(screen.getByTestId('trusted-signer-scope-0')).toHaveTextContent(/From the team library at runbooks\.example\.net/);
    expect(screen.getByTestId('trusted-signer-1')).toHaveTextContent(/any name ending in @example.net/);
    expect(screen.getByTestId('trusted-signer-withdrawn-1')).toHaveTextContent(/No longer published/);
    expect(screen.queryByTestId('trusted-signer-withdrawn-0')).toBeNull();
    expect(screen.getByTestId('trusted-signer-scope-2')).toHaveTextContent(/other\.example\.net/);
    expect(screen.getByTestId('trusted-signer-scope-3')).toHaveTextContent(/Added by you: counts for every runbook/);
    await press('trusted-signer-remove-1');
    expect(trustedSigners().map((s) => [s.principals[0], s.from])).toEqual([
      ['alice@example.net', LIB],
      ['alice@example.net', 'https://other.example.net/lib/'],
      ['ops@example.net', 'you'],
    ]);
    // Add: pasted lines, a line for run summaries only is not used.
    const carol = await generateKey();
    await type(
      'trusted-signers-add',
      (await allowedSignersLine(carol, 'carol@example.net')) + '\n' + (await allowedSignersLine(carol, 'x', 'md-runbook-run')),
    );
    await press('trusted-signers-add-go');
    expect(screen.getByTestId('trusted-signers-added')).toHaveTextContent(/1 signer added\. 1 line not used/);
    expect(trustedSigners().at(-1)).toMatchObject({ principals: ['carol@example.net'], from: 'you' });
  });
});

describe('Hosts & settings → Team library', () => {
  it('Forget the versions seen', async () => {
    const alice = await generateKey();
    const signedR = await signRunbook(
      RUNBOOK,
      { ...signPlan(RUNBOOK, 'restart.md'), version: 7 },
      { name: 'restart', scopes: '', days: '', patterns: {} },
      'alice@example.net',
      alice,
    );
    if (!signedR.ok) throw new Error('not signed');
    const files = {
      [LIB + 'index.json']: '["restart.md"]',
      [LIB + 'restart.md']: signedR.text,
      [LIB + 'allowed_signers']: (await allowedSignersLine(alice, 'alice@example.net')) + '\n',
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    await render(<LibrarySettings />);
    expect(screen.getByTestId('library-versions')).toHaveTextContent(/refuses a version older than the highest it saw/);
    await press('library-forget-versions');
    expect(screen.getByTestId('library-versions')).toHaveTextContent(/Forgotten/);
    expect(screen.queryByTestId('library-forget-versions')).toBeNull();
  });
});

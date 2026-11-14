/**
 * Run reports (report-runs: in the front matter): asked once per address at the end of a run,
 * the notice of a signed runbook that requires reporting, signed summaries, and the queue of
 * reports the server didn't take yet.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { RUN_SIGNATURE_NAMESPACE, canonicalJson, runSummaryProblems } from '@md-runbook/core/runReport';
import { SIGNATURE_NAMESPACE, buildManifest, formatManifest, unarmorSignature, withSignature } from '@md-runbook/core/signing';
import { allowedSignersLine, generateKey, signSshsig } from '@md-runbook/ssh';
import { addHost, resetHosts } from '../hosts/store';
import { queuedReports, resetReports, retryReports } from '../reports/send';
import { addLibraryCopy, addRunbook, resetRunbooks } from '../runbooks/store';
import { libraryHash, loadLibraryMemory, resetLibrary } from '../runbooks/library';
import { openRunbookLink } from '../runbooks/openLink';
import { resetParamValues } from '../runbooks/params';
import { formatRunbookLink } from '@md-runbook/core/runbookLink';
import { RunbookView } from '../screens/RunbookView';
import { resetSecretNames, storeSecret } from '../secrets/store';
import { resetSettings, setReportAddresses } from '../settings/store';
import { addSigners, parseAllowedSigners, resetTrustedSigners, trustSigners } from '../signing/trust';
import { parseSshsig, verifySshsig } from '../signing/verify';
import { Buffer } from 'buffer';
import { fakeConnection } from '../testing/fakeConnection';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
let mockPair: unknown = {};
jest.mock('../ssh/appKey', () => ({
  appKeyInfo: async () => ({ pair: mockPair, storage: 'hardware' }),
  appKey: async () => mockPair,
}));
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
  isConnected: jest.fn(() => false),
}));

const URL = 'https://reports.example.net/runs';
const runbookText = (front: string[]): string => ['---', ...front, '---', '# Check', '', '```bash', 'uptime', '```', ''].join('\n');

const fetchMock = jest.fn();
const sent = (): { url: string; body: string; headers: Record<string, string> }[] =>
  fetchMock.mock.calls.map(([url, init]: [string, { body: string; headers: Record<string, string> }]) => ({
    url,
    body: init.body,
    headers: init.headers,
  }));

beforeEach(async () => {
  await AsyncStorage.clear();
  resetHosts();
  resetRunbooks();
  resetSettings();
  resetSecretNames();
  resetReports();
  resetParamValues();
  resetTrustedSigners();
  resetLibrary();
  mockPair = {};
  mockConnection = fakeConnection([
    { stdout: ' 10:00:00 up 1 day, secret-ish output\n', exitCode: 0 },
    { stdout: 'again\n', exitCode: 0 },
    { stdout: 'third\n', exitCode: 0 },
  ]);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
});

async function runCell(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId('cell-1-run'));
  });
  await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
}

describe('asking before reporting a run', () => {
  it('asks once the run is over; Allow sends the summary and is remembered', async () => {
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`]));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
    expect(screen.getByText(/reports its runs to reports\.example\.net/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-allow'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [first] = sent();
    expect(first!.url).toBe(URL);
    const summary = JSON.parse(first!.body);
    expect(runSummaryProblems(summary)).toEqual([]);
    expect(summary).toMatchObject({ v: 1, client: 'app-ios', runbook: { file: 'check.md', title: 'Check' }, green: true, ran: [1] });
    expect(summary.steps).toEqual([{ n: 1, label: 'uptime', state: 'passed', ms: expect.any(Number) }]);
    // Never an output (the app has no key to sign with here: sent unsigned).
    expect(first!.body).not.toMatch(/up 1 day|secret-ish/);
    expect(first!.body).toBe(canonicalJson(summary));
    // Remembered: the next run is reported without asking.
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('report-consent')).toBeNull();
  });

  it('Not now sends nothing and asks again next time; Never sends nothing and is remembered', async () => {
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`]));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-not-now'));
    });
    expect(screen.queryByTestId('report-consent')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-never'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByText(/^third$/)).toBeTruthy());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByTestId('report-consent')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an address allowed in the settings is sent to without asking, with the token from the secret store', async () => {
    setReportAddresses('reports.example.net');
    await storeSecret('REPORT_TOKEN', 'tok-123');
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`, 'report-runs-token: ${secret:REPORT_TOKEN}']));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('report-consent')).toBeNull();
    expect(sent()[0]!.headers.authorization).toBe('Bearer tok-123');
    expect(sent()[0]!.body).not.toContain('tok-123');
  });

  it('signs the summary with the app key when it has one (namespace md-runbook-run)', async () => {
    const key = await generateKey();
    mockPair = key;
    setReportAddresses(URL);
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`]));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const envelope = JSON.parse(sent()[0]!.body);
    expect(envelope.signature).toMatch(/^-----BEGIN SSH SIGNATURE-----/);
    // Checked with the app's one verifier, in the run summaries' namespace, by the app's key.
    const blob = unarmorSignature(envelope.signature);
    const runners = parseAllowedSigners(
      await allowedSignersLine(key, 'phone@example.net', RUN_SIGNATURE_NAMESPACE),
      RUN_SIGNATURE_NAMESPACE,
    );
    expect(Buffer.from(parseSshsig(blob)!.publicKey).toString('base64')).toBe(runners.signers[0]!.key);
    expect(await verifySshsig(blob, canonicalJson(envelope.summary), RUN_SIGNATURE_NAMESPACE)).toBe(true);
    // Not a runbook signature: in the runbooks' namespace it doesn't verify, nor as runners' line for runbooks.
    expect(await verifySshsig(blob, canonicalJson(envelope.summary), SIGNATURE_NAMESPACE)).toBe(false);
    expect(parseAllowedSigners(await allowedSignersLine(key, 'phone@example.net', RUN_SIGNATURE_NAMESPACE), SIGNATURE_NAMESPACE)).toEqual({
      signers: [],
      skipped: 1,
    });
  });
});

describe('a signed runbook that requires reporting', () => {
  let signer: KeyPair;
  let text: string;
  beforeAll(async () => {
    signer = await generateKey();
    const unsigned = runbookText([`report-runs: ${URL}`, 'report-runs-required: true']);
    const built = buildManifest(unsigned, { name: 'ops/check', version: 1, scopes: [], patterns: {} });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const manifest = formatManifest(built.manifest);
    text = withSignature(unsigned, {
      signer: 'ops@example.net',
      signed: '2026-11-14',
      manifest,
      signature: await signSshsig(signer, manifest),
    });
  });

  it("from a trusted signer: a notice before anything runs; Don't run runs nothing, Run runs and reports", async () => {
    // Added by you (Hosts & settings → Trusted signers): counts for every runbook.
    expect(addSigners(await allowedSignersLine(signer, 'ops@example.net'))).toMatchObject({ added: 1 });
    const rb = addRunbook('check.md', text);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('report-required')).toBeTruthy());
    expect(screen.queryByTestId('report-never')).toBeNull();
    expect(mockConnection.calls).toHaveLength(0);
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-required-decline'));
    });
    expect(screen.queryByTestId('report-required')).toBeNull();
    expect(screen.getByTestId('run-notice').props.children).toMatch(/runs only when its runs are reported/);
    expect(mockConnection.calls).toHaveLength(0);
    // Asked again, and Run: it runs, and is reported without the end-of-run question.
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('report-required')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-required-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('report-consent')).toBeNull();
    const summary = JSON.parse(sent()[0]!.body);
    expect(summary.runbook.signed).toMatchObject({ name: 'ops/check', version: 1, signer: 'ops@example.net', trusted: true });
    // Agreed for this runbook in this session: the next run doesn't ask.
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('report-required')).toBeNull();
  });

  const LIB = 'https://runbooks.example.net/team/';
  const LINE = async (): Promise<string> => allowedSignersLine(signer, 'ops@example.net');
  const copyOf = (t: string, base = LIB) =>
    addLibraryCopy('check.md', t, { base, path: 'ops/check.md', hash: libraryHash(t), bare: libraryHash(t) });

  it("a team library copy: its library's trusted keys count for it", async () => {
    await loadLibraryMemory();
    trustSigners(parseAllowedSigners(await LINE(), SIGNATURE_NAMESPACE).signers, LIB);
    const rb = copyOf(text);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('report-required')).toBeTruthy());
    expect(mockConnection.calls).toHaveLength(0);
  });

  it("a key trusted from another library doesn't count for this library's copy", async () => {
    await loadLibraryMemory();
    trustSigners(parseAllowedSigners(await LINE(), SIGNATURE_NAMESPACE).signers, 'https://other.example.net/lib/');
    const rb = copyOf(text);
    await render(<RunbookView id={rb.id} />);
    await runCell();
    expect(screen.queryByTestId('report-required')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a library's key doesn't count for a runbook from elsewhere", async () => {
    trustSigners(parseAllowedSigners(await LINE(), SIGNATURE_NAMESPACE).signers, LIB);
    const rb = addRunbook('check.md', text);
    await render(<RunbookView id={rb.id} />);
    await runCell();
    expect(screen.queryByTestId('report-required')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
  });

  it('signed before manifest version 2 (only its blocks): the front matter is not signed, so it asks', async () => {
    const unsigned = runbookText([`report-runs: ${URL}`, 'report-runs-required: true']);
    const built = buildManifest(unsigned, { name: 'ops/check', version: 1, scopes: [], patterns: {} }, { version: 1 });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const manifest = formatManifest(built.manifest);
    const v1 = withSignature(unsigned, {
      signer: 'ops@example.net',
      signed: '2026-11-14',
      manifest,
      signature: await signSshsig(signer, manifest),
    });
    addSigners(await LINE());
    const rb = addRunbook('check.md', v1);
    await render(<RunbookView id={rb.id} />);
    await runCell();
    expect(screen.queryByTestId('report-required')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
  });

  it('from a signer the app does not trust: no notice, the run is asked about like any other', async () => {
    const rb = addRunbook('check.md', text);
    await render(<RunbookView id={rb.id} />);
    await runCell();
    expect(screen.queryByTestId('report-required')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('report-consent')).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a run opened from an alert link', () => {
  // An SOP as admin4 writes them: the alert parameters declared with empty defaults, used by no cell.
  const SOP = [
    '---',
    `report-runs: ${URL}`,
    'params:',
    '  - ALERT:',
    '  - ALERT_FINGERPRINT: ""',
    '  - ALERT_STARTS_AT: ""',
    '  - SERVICE: api',
    '---',
    '# Disk full',
    '',
    '```bash',
    'df -h /srv/${param:SERVICE}',
    '```',
    '',
  ].join('\n');

  it('declared alert parameters nobody filled ask for nothing and block nothing', async () => {
    setReportAddresses('reports.example.net');
    const rb = addRunbook('disk.md', SOP);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('param-ALERT')).toBeTruthy();
    await runCell();
    expect(mockConnection.calls).toHaveLength(1);
    expect(screen.queryByTestId('needs')).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // No ALERT value: no alert in the summary.
    expect(JSON.parse(sent()[0]!.body).alert).toBeUndefined();
  });

  it("reports the alert's name, fingerprint and start, never another parameter's value", async () => {
    setReportAddresses('reports.example.net');
    const link = formatRunbookLink({
      text: SOP,
      params: { ALERT: 'DiskFull', ALERT_FINGERPRINT: 'a1b2c3d4e5f6', ALERT_STARTS_AT: '2026-11-14T09:58:00Z', SERVICE: 'billing-7x9q' },
    });
    const opened = await openRunbookLink(link, (async () => {
      throw new Error('no network');
    }) as unknown as typeof fetch);
    if (opened.kind !== 'opened') throw new Error(JSON.stringify(opened));
    await render(<RunbookView id={opened.runbook.id} />);
    await runCell();
    expect(mockConnection.calls[0]?.opts.env).toMatchObject({ SERVICE: 'billing-7x9q' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = sent()[0]!.body;
    const summary = JSON.parse(body);
    expect(runSummaryProblems(summary)).toEqual([]);
    expect(summary.alert).toEqual({ name: 'DiskFull', fingerprint: 'a1b2c3d4e5f6', startsAt: '2026-11-14T09:58:00Z' });
    expect(body).not.toContain('billing-7x9q');
  });
});

describe('reports the server did not take', () => {
  it('are queued (without the token) and sent later', async () => {
    setReportAddresses('reports.example.net');
    await storeSecret('REPORT_TOKEN', 'tok-123');
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`, 'report-runs-token: ${secret:REPORT_TOKEN}']));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(async () => expect(await queuedReports()).toHaveLength(1));
    const [queued] = await queuedReports();
    expect(queued).toMatchObject({ url: URL, token: 'REPORT_TOKEN', tries: 1 });
    expect(JSON.stringify(await queuedReports())).not.toContain('tok-123');
    // Not due yet: nothing is sent.
    await retryReports(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Later, the server answers.
    await retryReports(Date.now() + 10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent()[1]!.body).toBe(queued!.body);
    expect(sent()[1]!.headers.authorization).toBe('Bearer tok-123');
    expect(await queuedReports()).toEqual([]);
  });

  it('a refusal (4xx) is not queued; a server error is', async () => {
    setReportAddresses('reports.example.net');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce({ ok: false, status: 503 });
    const rb = addRunbook('check.md', runbookText([`report-runs: ${URL}`]));
    await render(<RunbookView id={rb.id} />);
    await runCell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await queuedReports()).toEqual([]);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(async () => expect(await queuedReports()).toHaveLength(1));
  });
});

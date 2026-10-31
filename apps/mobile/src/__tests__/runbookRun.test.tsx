import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { addHost, getHost, pinHostKey, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings, setOutputSetting, signerName } from '../settings/store';
import { HostList } from '../screens/HostList';
import { formatRunbookLink } from '@md-runbook/core/runbookLink';
import { openRunbookLink } from '../runbooks/openLink';
import { HostsButton } from '../ui/HomeHeader';
import { RunbookView } from '../screens/RunbookView';
import { FakeRun, fakeConnection } from '../testing/fakeConnection';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
jest.mock('../ssh/appKey', () => ({
  appPublicKeyLine: async () => 'ecdsa-sha2-nistp256 AAAAtest md-runbook-app',
  appKeyInfo: async () => ({ pair: {}, storage: 'hardware' }),
  appAllowedSignersLine: async (who: string) => `${who} namespaces="md-runbook" ecdsa-sha2-nistp256 AAAAtest`,
}));
let script: FakeRun[] = [];
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
  isConnected: jest.fn(() => false),
}));

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  script = [{ stdout: ' 10:00:00 up 1 day\n', exitCode: 0 }];
  mockConnection = fakeConnection(script);
});

describe('running a cell from the runbook screen', () => {
  it('needs a host first', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId('add-host-link')).toBeTruthy();
    expect(screen.queryByTestId('cell-1-run')).toBeNull();
  });

  it('runs on the chosen host and shows the new output block', async () => {
    const h = addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId(`host-chip-${h.id}`)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(screen.getByText(/10:00:00 up 1 day/)).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
    expect(mockConnection.calls[0]?.source).toBe('uptime\ndf -h /');
    expect(screen.queryByTestId('run-notice')).toBeNull();
  });

  it('asks before trusting an unknown host key, then runs', async () => {
    const h = addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const key =
      'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGe+ETSSEqfHjc1rfcKRwiVWwN+Nqk1V6oxk6ncqNZAlmVWJmcx8yz8+pkKv7dV0lbsEzdW4U2/pF5yU6Jc8OmY=';
    mockConnection = fakeConnection([{ unknownHostKey: key }, { stdout: 'ran\n', exitCode: 0 }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('trust-host')).toBeTruthy());
    expect(screen.getByTestId('trust-fingerprint').props.children).toMatch(/^SHA256:/);
    expect(getHost(h.id)?.hostKey).toBeUndefined();
    await act(async () => {
      fireEvent.press(screen.getByTestId('trust-accept'));
    });
    await waitFor(() => expect(screen.getByText(/^ran$/)).toBeTruthy());
    expect(getHost(h.id)?.hostKey).toBe(key);
    expect(screen.queryByTestId('trust-host')).toBeNull();
  });

  it('shows errors and the new-shell notice', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ error: 'connect ECONNREFUSED 10.0.0.1:22' }, { stdout: 'x\n', newShell: true }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('run-notice').props.children).toContain('ECONNREFUSED'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('run-notice').props.children).toMatch(/new shell/));
  });

  it('a running cell can be stopped', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ waitForAbort: true }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-stop')).toBeTruthy());
    expect(screen.getByTestId('cell-1-live')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
    await waitFor(() => expect(screen.getByText(/cancelled/)).toBeTruthy());
  });
});

describe('asking before a risky cell, as VS Code does', () => {
  const RISKY = [
    '# Rollout',
    '',
    '```bash',
    'kubectl get pods',
    '```',
    '',
    '```bash',
    'kubectl rollout restart deploy/api',
    '```',
    '',
    '```bash',
    'kubectl get pods -w',
    '```',
    '',
    '```bash confirm',
    'echo careful',
    '```',
    '',
    '```bash no-confirm',
    'kubectl delete pod web-1',
    '```',
    '',
  ].join('\n');
  // Cells: 0 heading, 1 get, 2 rollout restart (risky), 3 get -w, 4 confirm, 5 no-confirm + delete.
  beforeEach(() => resetSettings());

  it('a risky cell waits for Run under it; nothing is sent before', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('rollout.md', RISKY);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-2-run'));
    });
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Cell 3 contains a risky command: “rollout restart”');
    expect(screen.getByText('It runs as deploy@web-1.')).toBeTruthy();
    expect(mockConnection.calls).toHaveLength(0);
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-2-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['kubectl rollout restart deploy/api']);
    expect(screen.queryByTestId('confirm-card')).toBeNull();
  });

  it('Run all stops at a risky cell until it is confirmed; Cancel ends it there', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('rollout.md', RISKY);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-card')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['kubectl get pods']);
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-cancel'));
    });
    expect(screen.getByTestId('run-notice').props.children).toBe('Cell 3 was not run: you didn’t confirm it.');
    expect(mockConnection.calls).toHaveLength(1);
    expect(getRunbook(rb.id)?.text).not.toMatch(/rollout restart deploy\/api\n```\n<!-- md-runbook:output/);

    // Again, confirmed: Run all goes on to the next cell and asks at `confirm`.
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-card')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-run'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-title')).toHaveTextContent('Run cell 5?'));
    expect(mockConnection.calls.map((c) => c.source).slice(-2)).toEqual(['kubectl rollout restart deploy/api', 'kubectl get pods -w']);
  });

  it("a runbook's no-confirm counts only when Hosts & settings allows it", async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('rollout.md', RISKY);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-5-run'));
    });
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Cell 6 contains a risky command: “delete”');
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-cancel'));
    });
    await act(async () => setOutputSetting('allowNoConfirm', true));
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-5-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-5-output')).toBeTruthy());
    expect(screen.queryByTestId('confirm-card')).toBeNull();
  });

  it('retry=: the running cell says which attempt, and Stop ends the wait', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ stdout: '{"outcome":"error"}\n' }]);
    const rb = addRunbook(
      'login.md',
      '# Login\n\n```bash retry=10 every=30s expect=/"outcome":"signed_in"/\ncurl -s localhost/login\n```\n',
    );
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('cell-1-running')).toHaveTextContent('Attempt 1/10 failed · trying again in 30.0s (Stop to end here)'),
    );
    expect(screen.getByText(/attempt 1\/10 failed \(the output does not match/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls).toHaveLength(1);
    expect(screen.getByText(/cancelled · check failed · 1 attempts/)).toBeTruthy();
  });
});

describe('hosts screens', () => {
  it('the home screen links to the hosts; the hosts screen shows the public key', async () => {
    await render(<HostsButton />);
    expect(screen.getByTestId('hosts').props.accessibilityLabel).toBe('Hosts & settings');
    await render(<HostList />);
    await waitFor(() => expect(screen.getByTestId('app-public-key').props.children).toMatch(/^ecdsa-sha2-nistp256 /));
    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-public-key'));
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it("Signing: the name for signatures, and the key's line for the servers' allowed_signers", async () => {
    await render(<HostList />);
    // No line (and no Copy) until a name is set; a name allowed_signers would misread gets none either.
    expect(screen.getByTestId('allowed-signers-line').props.children).toMatch(/Set your name above/);
    expect(screen.getByTestId('copy-allowed-signers').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('signer-name'), 'Stephane Mojon');
    });
    expect(screen.getByTestId('signer-name-rule')).toBeTruthy();
    expect(screen.getByTestId('allowed-signers-line').props.children).toMatch(/Set your name above/);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('signer-name'), 'me@example.net');
    });
    await waitFor(() =>
      expect(screen.getByTestId('allowed-signers-line').props.children).toMatch(
        /^me@example\.net namespaces="md-runbook" ecdsa-sha2-nistp256 /,
      ),
    );
    await act(async () => {
      fireEvent(screen.getByTestId('signer-name'), 'blur');
    });
    expect(signerName()).toBe('me@example.net');
  });
});

describe('a runbook opened from a link', () => {
  it('says how far the link is trusted, picks its host, and says why it cannot be co-signed', async () => {
    addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    const web2 = addHost({ name: 'web-2', hostname: 'web2.example.net', port: 22, username: 'deploy' });
    const text = '# Check\n\n```bash\nuptime\n```\n';
    const r = await openRunbookLink(formatRunbookLink({ text, host: 'web-2', params: { NOPE: '1' }, action: 'cosign' }));
    if (r.kind !== 'opened') throw new Error(r.message);
    await render(<RunbookView id={r.runbook.id} />);
    expect(screen.getByTestId('link-trust-unverified')).toBeTruthy();
    expect(screen.getByTestId('link-ignored-params').props.children).toMatch(/NOPE/);
    expect(screen.getByTestId(`host-chip-${web2.id}`).props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('run-notice').props.children).toMatch(/^Not signed yet/);
  });
});

describe('practice on a host (drills)', () => {
  const { connectionFor } = jest.requireMock<{ connectionFor: jest.Mock }>('../ssh/connections');

  it('every cell runs on the practice host, even one that says host=prod', async () => {
    addHost({ name: 'prod', hostname: 'prod.example.net', port: 22, username: 'ops' });
    const train = addHost({ name: 'train', hostname: 'train.example.net', port: 22, username: 'ops' });
    const r = addRunbook('drill.md', '---\npractice: train\n---\n\n# Drill\n\n```bash host=prod\nuptime\n```\n');
    connectionFor.mockClear();
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('practice-banner')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(connectionFor).toHaveBeenCalled());
    expect(connectionFor.mock.calls[0]![0].id).toBe(train.id);
    expect(screen.queryByText(/This cell runs on prod/)).toBeNull();
  });

  it('a practice host the app does not have stops the run instead of using the selected host', async () => {
    addHost({ name: 'prod', hostname: 'prod.example.net', port: 22, username: 'ops' });
    const r = addRunbook('drill.md', '---\npractice: train\n---\n\n# Drill\n\n```bash\nuptime\n```\n');
    connectionFor.mockClear();
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('practice-missing')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    expect(connectionFor).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-notice').props.children).toMatch(/no host with that name/);
  });
});

describe('run on a group', () => {
  it('runs the cell on each trusted host of the group and writes a section per host', async () => {
    const a = addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'ops', group: 'acme' });
    const b = addHost({ name: 'web-2', hostname: 'web2.example.net', port: 22, username: 'ops', group: 'acme' });
    addHost({ name: 'web-3', hostname: 'web3.example.net', port: 22, username: 'ops', group: 'acme' });
    addHost({ name: 'other', hostname: 'other.example.net', port: 22, username: 'ops', group: 'beta' });
    pinHostKey(a.id, 'ecdsa-sha2-nistp256 AAAA1=');
    pinHostKey(b.id, 'ecdsa-sha2-nistp256 AAAA2=');
    mockConnection = fakeConnection([
      { stdout: 'up 1 day\n', exitCode: 0 },
      { stdout: 'disk full\n', exitCode: 2 },
    ]);
    const r = addRunbook('check.md', '# Check\n\n```bash\nuptime\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-runOnGroup'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('group-acme'));
    });
    await waitFor(() => expect(parse(getRunbook(r.id)!.text).cells[1]?.output).toBeDefined());
    const out = parse(getRunbook(r.id)!.text).cells[1]!.output!;
    expect(out.attrs).toMatchObject({ exit: '2', group: 'acme', hosts: 'web-1,web-2,web-3', failed: 'web-2,web-3' });
    expect(out.text).toContain('── web-1 (ops@web1.example.net) · exit 0 ──\nup 1 day\n');
    expect(out.text).toContain('── web-2 (ops@web2.example.net) · 2 ──\ndisk full\n');
    expect(out.text).toMatch(/── web-3 .*skipped ──\n\[md-runbook\] web-3 skipped: its host key isn't trusted yet/);
    expect(screen.getByTestId('group-result-web-2').props.children).toBe('✗ web-2');
  });
});

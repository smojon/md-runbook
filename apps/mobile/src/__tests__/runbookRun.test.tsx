import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, getHost, resetHosts } from '../hosts/store';
import { resetRunbooks } from '../runbooks/store';
import { HostList } from '../screens/HostList';
import { RunbookList } from '../screens/RunbookList';
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
}));
let script: FakeRun[] = [];
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
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

describe('hosts screens', () => {
  it('the home screen links to the hosts; the hosts screen shows the public key', async () => {
    await render(<RunbookList />);
    expect(screen.getByTestId('hosts')).toBeTruthy();
    await render(<HostList />);
    await waitFor(() => expect(screen.getByTestId('app-public-key').props.children).toMatch(/^ecdsa-sha2-nistp256 /));
    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-public-key'));
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });
});

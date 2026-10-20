import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { addHost, resetHosts } from '../hosts/store';
import { getRunbook, resetRunbooks } from '../runbooks/store';
import { RunbookView } from '../screens/RunbookView';
import { FakeRun, fakeConnection } from '../testing/fakeConnection';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
}));

const script = (runs: FakeRun[]) => (mockConnection = fakeConnection(runs));

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  script([{ stdout: 'ok\n' }]);
});

describe('the VS Code-like runbook view', () => {
  it('renders Markdown cells as text, not source', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByText('Check a web server')).toBeTruthy();
    expect(screen.queryByText(/^# Check/)).toBeNull();
    expect(screen.getByText('Service')).toBeTruthy();
    expect(screen.getByText('Log in to the server')).toBeTruthy();
  });

  it('a task box ticks the item in the runbook and back', async () => {
    await render(<RunbookView id="sample" />);
    const box = screen.getByTestId('task-0');
    expect(box.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => {
      fireEvent.press(box);
    });
    expect(getRunbook('sample')?.text).toContain('- [x] Log in to the server');
    expect(screen.getByTestId('task-0').props.accessibilityState).toMatchObject({ checked: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-0'));
    });
    expect(getRunbook('sample')?.text).toContain('- [ ] Log in to the server');
  });

  it('shows the last result of a cell and the language with its options', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId('cell-1-status').props.accessibilityLabel).toBe('Succeeded');
    expect(screen.getByText('bash expect=/active \\(running\\)/')).toBeTruthy();
  });

  it('a tap on a line opens its actions; Run line runs that command only', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: '/dev/sda1 40G\n' }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1'));
    });
    expect(screen.getByTestId('cell-1-line-1-actions')).toBeTruthy();
    expect(screen.getByText('Run line 2')).toBeTruthy();
    expect(screen.getByText('Run lines 1-2')).toBeTruthy();
    // The last command has no "Run lines N-end".
    expect(screen.queryByTestId('cell-1-line-1-run-from')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['df -h /']);
    const out = parse(getRunbook('sample')!.text).cells[1]?.output;
    expect(out?.attrs.lines).toBe('2');
    expect(out?.text).toBe('$ df -h /\n/dev/sda1 40G');
    expect(screen.getByText(/lines 2/)).toBeTruthy();
  });

  it('checked lines get a run button on the status line', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: 'up\n' }]);
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('cell-1-run-checked')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-0'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-0-check'));
    });
    expect(screen.getByText('Run 1 checked line')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run-checked'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    expect(mockConnection.calls[0]?.source).toBe('uptime');
    await waitFor(() => expect(parse(getRunbook('sample')!.text).cells[1]?.output?.attrs.lines).toBe('1'));
  });

  it('without a host there is no run button and no line actions are open', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('cell-1-run')).toBeNull();
    expect(screen.queryByTestId('cell-1-line-0-actions')).toBeNull();
  });
});

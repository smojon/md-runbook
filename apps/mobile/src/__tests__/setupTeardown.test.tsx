/**
 * Setup and teardown in the app (core/parts.ts): Run all runs the ready check, skips a setup
 * already up, and offers the teardown on a card; the run bar shows the three parts.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { callCells, readyCellOf } from '../runbooks/calls';
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
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
  isConnected: jest.fn(() => false),
}));

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';

// Cells: 0 heading, 1 ready, 2 heading, 3 setup, 4 heading, 5 the work, 6 heading, 7 teardown.
const GUIDE = [
  '# Guide',
  '',
  fence('bash ready name="the lab"', 'test -f lab.up'),
  '## 1. Start',
  '',
  fence('bash setup estimate=19m', 'touch lab.up'),
  '## 2. Work',
  '',
  fence('bash estimate=55m', 'echo work'),
  '## 3. Stop',
  '',
  fence('bash teardown estimate=2m name="Stop the lab"', 'rm lab.up'),
].join('\n');

const sources = (): string[] => mockConnection.calls.map((c) => c.source);

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  addHost({ name: 'lab', hostname: 'lab', port: 22, username: 'me' });
});

describe('setup and teardown in Run all', () => {
  it('the ready check says up: the setup is skipped; Not now leaves the teardown and is not asked again', async () => {
    const script: FakeRun[] = [
      { exitCode: 0 },
      { stdout: 'work\n', exitCode: 0 },
      { exitCode: 0 },
      { stdout: 'work\n', exitCode: 0 },
    ];
    mockConnection = fakeConnection(script);
    const rb = addRunbook('guide.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    // Before the check: the setup is what it may add, the teardown is offered.
    expect(screen.getByTestId('run-estimate-text')).toHaveTextContent(/about 55 min left · \+19m if the setup runs · teardown 2m, offered/);
    expect(screen.getByTestId('bar-setup')).toBeTruthy();
    expect(screen.getByTestId('bar-teardown')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('teardown-card')).toBeTruthy());
    expect(screen.getByTestId('teardown-title')).toHaveTextContent('Run the teardown now: Stop the lab?');
    expect(sources()).toEqual(['test -f lab.up', 'echo work']);
    const text = getRunbook(rb.id)!.text;
    expect(text).toMatch(/exit=0 [^\n]*check=ok [^\n]*ready=up/);
    expect(text).toMatch(/touch lab\.up\n```\n<!-- md-runbook:output start exit=skipped ready=up/);
    // Already up: the setup segment is gone.
    expect(screen.queryByTestId('bar-setup')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('teardown-not-now'));
    });
    expect(screen.queryByTestId('teardown-card')).toBeNull();
    expect(getRunbook(rb.id)!.text).not.toMatch(/rm lab\.up\n```\n<!-- md-runbook:output/);

    // Continue, with only the teardown left, asks for it: offered again.
    expect(screen.getByTestId('run-primary')).toHaveTextContent('▶ Continue');
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('teardown-card')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('teardown-not-now'));
    });
    // Run all from the start: not asked again for this runbook.
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-from-start'));
    });
    await waitFor(() => expect(sources()).toHaveLength(4));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByTestId('teardown-card')).toBeNull();
    expect(sources()).not.toContain('rm lab.up');
  });

  it('the ready check says down: the setup runs (the check never stops Run all); Take down runs the teardown', async () => {
    mockConnection = fakeConnection([{ exitCode: 1 }, { exitCode: 0 }, { stdout: 'work\n', exitCode: 0 }, { exitCode: 0 }]);
    const rb = addRunbook('guide-2.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('teardown-card')).toBeTruthy());
    expect(sources()).toEqual(['test -f lab.up', 'touch lab.up', 'echo work']);
    expect(getRunbook(rb.id)!.text).toMatch(/exit=1 [^\n]*check=ok [^\n]*ready=down/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('teardown-take'));
    });
    await waitFor(() => expect(sources()).toEqual(['test -f lab.up', 'touch lab.up', 'echo work', 'rm lab.up']));
    await waitFor(() => expect(getRunbook(rb.id)!.text).toMatch(/rm lab\.up\n```\n<!-- md-runbook:output start exit=0/));
  });
});

describe('a setup call', () => {
  const LAB = ['# The lab', '', fence('bash ready', 'test -f lab.up'), '## Start the lab', '', fence('bash', 'touch lab.up'), '## Stop the lab', '', fence('bash', 'rm lab.up')].join('\n');

  it("runs the ready check of the runbook it calls first, whatever section= selects", () => {
    expect(readyCellOf(LAB)).toBe(1);
    expect(callCells(LAB, { sections: ['Start the lab'], resumed: false, setup: true })).toEqual([1, 3]);
    expect(callCells(LAB, { sections: ['Stop the lab'], resumed: false })).toEqual([5]);
  });
});

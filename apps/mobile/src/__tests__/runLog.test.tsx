/**
 * Show Runs…, as VS Code's: each run on this device's record (steps, states and times, never an
 * output), newest first in a sheet from ⋯ More → Run and the Steps header. A run copy's runs
 * count for the runbook it was copied from.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, resetHosts } from '../hosts/store';
import { RUNS_PER_RUNBOOK, recordRun, resetRunLog, runEntry, runLogKey, runsOf } from '../runbooks/runLog';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { RunbookView } from '../screens/RunbookView';
import { resetSettings, setSignerName } from '../settings/store';
import { fakeConnection } from '../testing/fakeConnection';
import { RunsSheet, runDetail, runHeadline } from '../ui/RunsSheet';

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
  isConnected: jest.fn(() => false),
}));

const STARTED = Date.parse('2026-11-16T14:00:00Z');
const out = (exit: number, at = '2026-11-16T14:00:05Z'): string =>
  `<!-- md-runbook:output start exit=${exit} ran=${at} duration=3s -->\n\`\`\`text\nsecret-ish output\n\`\`\`\n<!-- md-runbook:output end -->\n`;
const DEPLOY = (second: string): string =>
  ['# Deploy', '', '```bash name="Build"', 'make', '```', out(0), '```bash name="Push"', 'make push', '```', second].join('\n');

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunLog();
  resetRunbooks();
  resetHosts();
  resetSettings();
});

describe('the run log (the logic)', () => {
  it('records the steps a run ran, with their state and time; never an output', () => {
    const e = runEntry(DEPLOY(out(1)), STARTED, STARTED + 10_000, 'ana')!;
    expect(e).toMatchObject({ by: 'ana', total: 2, complete: 1, green: false });
    expect(e.steps).toEqual([
      { label: 'Build', state: 'passed', ms: 3000 },
      { label: 'Push', state: 'failed', ms: 3000 },
    ]);
    expect(JSON.stringify(e)).not.toMatch(/secret-ish/);
    expect(runHeadline(e)).toBe('Failed at Push');
    expect(runDetail(e)).toBe('by ana · 1 passed, 1 failed');
    const green = runEntry(DEPLOY(out(0)), STARTED, STARTED + 10_000)!;
    expect([green.green, runHeadline(green), runDetail(green)]).toEqual([true, 'Done · 2 of 2', '2 passed']);
  });

  it('a run before `started` is not this run’s; no step ran: nothing to record', () => {
    expect(runEntry(DEPLOY(out(0)), Date.parse('2026-11-16T15:00:00Z'), Date.parse('2026-11-16T15:00:01Z'))).toBeUndefined();
  });

  it('keeps the last runs per runbook, and a run copy’s runs count for its original', async () => {
    const original = addRunbook('deploy.md', DEPLOY(''));
    const copy = addRunbook('deploy.20261116-140000.md', DEPLOY(''));
    expect(runLogKey(copy)).toBe(original.id);
    const e = runEntry(DEPLOY(out(0)), STARTED, STARTED + 1000)!;
    for (let i = 0; i < RUNS_PER_RUNBOOK + 2; i++) await recordRun(original, { ...e, started: STARTED + i });
    await recordRun(copy, e);
    const runs = runsOf(original.id);
    expect(runs).toHaveLength(RUNS_PER_RUNBOOK);
    expect(runs[runs.length - 1]!.copy).toBe('deploy.20261116-140000.md');
    // Kept between launches.
    expect(await AsyncStorage.getItem('md-runbook.runLog')).toContain('deploy.20261116-140000.md');
  });
});

describe('Show Runs…', () => {
  it('says so when nothing is recorded yet', async () => {
    await render(<RunsSheet runsKey="x" title="Deploy" visible onClose={() => undefined} />);
    expect(screen.getByTestId('runs-empty')).toHaveTextContent(/No run recorded yet/);
  });

  it('opens from the Steps header too', async () => {
    const rb = addRunbook('check.md', ['# Check', '', '```bash name="Uptime"', 'uptime', '```', ''].join('\n'));
    await render(<RunbookView id={rb.id} />);
    expect(screen.queryByTestId('runs-empty')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-showSteps'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-show-runs'));
    });
    expect(screen.getByTestId('runs-empty')).toBeTruthy();
  });

  it('a run of the runbook shows in the sheet, newest first, with its steps on a tap', async () => {
    setSignerName('ana@example.net');
    mockConnection = fakeConnection([{ stdout: 'ok\n', exitCode: 0 }]);
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('check.md', ['# Check', '', '```bash name="Uptime"', 'uptime', '```', ''].join('\n'));
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(runsOf(rb.id)).toHaveLength(1));
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-showRuns'));
    });
    expect(screen.getByTestId('run-0-headline')).toHaveTextContent('Done · 1 of 1');
    expect(screen.getByTestId('run-0-detail')).toHaveTextContent('by ana@example.net · 1 passed');
    expect(screen.getByTestId('runs-last-green')).toHaveTextContent(/Last ran green: just now \(by ana@example\.net\)/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-0'));
    });
    expect(screen.getByTestId('run-0-steps')).toHaveTextContent(/Uptime.*Passed/);
  });
});

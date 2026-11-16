/**
 * Marks on a step for this session, as VS Code's (stepMarks.ts): Pause Before This Step (Run all
 * stops there and asks Continue / Stop on the cell and on its row in Steps) and Notify Me When It
 * Starts (once: a notification while the app is away, the notice on screen). Set from the cell's
 * ⋯ (which the Steps rows open too), off again from the same menu or a tap on the cell's mark.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { AppState, AppStateStatus } from 'react-native';
import { addHost, resetHosts } from '../hosts/store';
import { resetRunNotifications } from '../notifications/runs';
import { NO_MARKS, toggleMark } from '../runbooks/stepMarks';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings, setNotifyRuns } from '../settings/store';
import { RunbookView } from '../screens/RunbookView';
import { fakeConnection } from '../testing/fakeConnection';

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

const N = jest.mocked(Notifications);
const GRANTED = { status: 'granted', granted: true, canAskAgain: true, expires: 'never' } as Notifications.NotificationPermissionsStatus;
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
// Cells: 0 "# Deploy", 1 Build, 2 Push, 3 Check.
const DEPLOY = [
  '# Deploy',
  '',
  fence('bash name="Build image"', 'make image'),
  fence('bash name="Push image"', 'make push'),
  fence('bash name="Check"', 'make check'),
].join('\n');
const sources = (): string[] => mockConnection.calls.map((c) => c.source);
const press = async (id: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};
const cellAction = async (cell: number, id: string): Promise<void> => {
  await press(`cell-${cell}-actions`);
  await press(`action-${id}`);
};
const shownNow = (): string[] =>
  N.scheduleNotificationAsync.mock.calls.filter(([r]) => r.trigger === null).map(([r]) => `${r.content.title}: ${r.content.body}`);

let appState: AppStateStatus = 'active';
beforeEach(() => {
  jest.clearAllMocks();
  resetHosts();
  resetRunbooks();
  resetSettings();
  resetRunNotifications();
  addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
  N.getPermissionsAsync.mockResolvedValue(GRANTED);
  N.scheduleNotificationAsync.mockImplementation(async () => 'n1');
  appState = 'active';
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appState });
});

describe('toggleMark', () => {
  it('turns a mark on and off; a cell without marks is dropped', () => {
    const a = toggleMark(NO_MARKS, 2, 'pause');
    expect(a.get(2)).toEqual({ pause: true });
    const b = toggleMark(a, 2, 'notify', true);
    expect(b.get(2)).toEqual({ pause: true, notify: true });
    expect(toggleMark(toggleMark(b, 2, 'pause'), 2, 'notify', false).has(2)).toBe(false);
    // Unchanged input.
    expect(a.get(2)).toEqual({ pause: true });
  });
});

describe('Pause Before This Step', () => {
  it('Run all stops before the step and asks; Continue runs it and goes on', async () => {
    mockConnection = fakeConnection([{ stdout: '1\n' }, { stdout: '2\n' }, { stdout: '3\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await cellAction(2, 'pauseBefore');
    expect(screen.getByTestId('cell-2-pauses')).toHaveProp('accessibilityLabel', 'Pauses here');
    await press('run-primary');
    await waitFor(() => expect(screen.getByTestId('pause-card')).toBeTruthy());
    expect(screen.getByTestId('pause-title')).toHaveTextContent('Paused before Push image');
    expect(sources()).toEqual(['make image']);
    // In Steps too: the row's mark and the question's buttons.
    await press('view-steps');
    expect(screen.getByTestId('steps-paused-2')).toBeTruthy();
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', expect.stringContaining('pauses before it'));
    expect(screen.getByTestId('steps-headline')).toHaveTextContent('Waiting for you');
    await press('steps-answer-2-continue');
    await waitFor(() => expect(sources()).toEqual(['make image', 'make push', 'make check']));
    expect(screen.queryByTestId('pause-card')).toBeNull();
  });

  it('Stop ends the run there; Resume pauses there again', async () => {
    mockConnection = fakeConnection([{ stdout: '1\n' }, { stdout: '2\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await cellAction(2, 'pauseBefore');
    await press('run-primary');
    await waitFor(() => expect(screen.getByTestId('pause-card')).toBeTruthy());
    await press('pause-stop');
    expect(screen.getByTestId('run-notice')).toHaveTextContent(/^Run all stopped before a step marked to pause/);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(sources()).toEqual(['make image']);
    await press('run-primary');
    await waitFor(() => expect(screen.getByTestId('pause-card')).toBeTruthy());
    expect(sources()).toEqual(['make image']);
  });

  it('a run of that cell alone doesn’t pause; Don’t Pause Here and a tap on the mark take it off', async () => {
    mockConnection = fakeConnection([{ stdout: '2\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await cellAction(2, 'pauseBefore');
    await press('cell-2-run');
    await waitFor(() => expect(sources()).toEqual(['make push']));
    expect(screen.queryByTestId('pause-card')).toBeNull();
    // The menu says what it does now.
    await press('cell-2-actions');
    expect(screen.queryByTestId('action-pauseBefore')).toBeNull();
    await press('action-removePause');
    expect(screen.queryByTestId('cell-2-pauses')).toBeNull();
    await cellAction(2, 'pauseBefore');
    await press('cell-2-pauses');
    expect(screen.queryByTestId('cell-2-pauses')).toBeNull();
  });
});

describe('Notify Me When It Starts', () => {
  it('on screen: the notice says it, once; the mark goes', async () => {
    mockConnection = fakeConnection([{ stdout: '1\n' }, { stdout: '2\n' }, { stdout: '3\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    setNotifyRuns(true);
    await cellAction(3, 'notifyOnStart');
    expect(screen.getByTestId('cell-3-notifies')).toBeTruthy();
    await press('view-steps');
    expect(screen.getByTestId('steps-notify-3')).toBeTruthy();
    await press('view-runbook');
    await press('run-primary');
    await waitFor(() => expect(sources()).toHaveLength(3));
    await waitFor(() => expect(screen.queryByTestId('cell-3-notifies')).toBeNull());
    expect(shownNow()).toEqual([]);
  });

  it('away: a notification when the step starts, opening at it', async () => {
    mockConnection = fakeConnection([{ stdout: '1\n' }, { waitForAbort: true }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    setNotifyRuns(true);
    await cellAction(2, 'notifyOnStart');
    appState = 'background';
    await press('run-primary');
    await waitFor(() => expect(shownNow()).toEqual(['Deploy: Step 2 of 3 started: Push image']));
    const data = N.scheduleNotificationAsync.mock.calls.find(([r]) => r.trigger === null)![0].content.data;
    expect(data).toEqual({ runbookId: rb.id, cellIndex: 2 });
    appState = 'active';
    await press('view-steps');
    await press('steps-stop');
  });

  it('with notifications off, setting it says only this screen will tell', async () => {
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    setNotifyRuns(false);
    await cellAction(2, 'notifyOnStart');
    expect(screen.getByTestId('run-notice')).toHaveTextContent(/^Notifications are off/);
    await press('cell-2-actions');
    await press('action-cancelNotify');
    expect(screen.queryByTestId('cell-2-notifies')).toBeNull();
  });
});

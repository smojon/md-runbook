/**
 * Notifications about runs (notifications/*): a run that ends or waits while the app is in the
 * background says so in the run bar's words; the "paused" one when the app goes away mid-run;
 * nothing on screen, when turned off or refused; asked once, at the first Run all; a tap opens the
 * runbook at the step.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { AppState, AppStateStatus, FlatList } from 'react-native';
import { parse } from '@md-runbook/core';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { notifyRuns, resetSettings, setNotifyRuns } from '../settings/store';
import { PAUSED_AFTER_SECONDS, resetRunNotifications } from '../notifications/runs';
import { resetOpenRequests, useNotificationTaps } from '../notifications/open';
import { HostList } from '../screens/HostList';
import { RunbookView } from '../screens/RunbookView';
import { fakeConnection } from '../testing/fakeConnection';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useRootNavigationState: () => ({ key: 'root' }),
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

const N = jest.mocked(Notifications);
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const DEPLOY = ['# Deploy checkout', '', fence('bash name="Build image"', 'make image'), fence('bash name="Push image"', 'make push')].join(
  '\n',
);
const WITH_HAND_STEP = [
  '# Deploy checkout',
  '',
  fence('bash name="Build image"', 'make image'),
  '- [ ] Tell #checkout the deploy starts',
  '',
  fence('bash name="Push image"', 'make push'),
].join('\n');

const GRANTED = { status: 'granted', granted: true, canAskAgain: true, expires: 'never' } as Notifications.NotificationPermissionsStatus;
const UNDETERMINED = {
  status: 'undetermined',
  granted: false,
  canAskAgain: true,
  expires: 'never',
} as Notifications.NotificationPermissionsStatus;
const DENIED = { status: 'denied', granted: false, canAskAgain: false, expires: 'never' } as Notifications.NotificationPermissionsStatus;

// The app's state as the tests set it, and the screen's listeners for its changes.
let appState: AppStateStatus = 'active';
let appListeners: ((s: AppStateStatus) => void)[] = [];
const goTo = async (s: AppStateStatus): Promise<void> => {
  appState = s;
  await act(async () => {
    appListeners.forEach((l) => l(s));
  });
};

/** What was shown at once (trigger null), as `title: body`. */
const shownNow = (): string[] =>
  N.scheduleNotificationAsync.mock.calls.filter(([r]) => r.trigger === null).map(([r]) => `${r.content.title}: ${r.content.body}`);

/** The data of those (what a tap opens). */
const shownData = (): unknown[] => N.scheduleNotificationAsync.mock.calls.filter(([r]) => r.trigger === null).map(([r]) => r.content.data);

const runAll = async (): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId('run-primary'));
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  resetHosts();
  resetRunbooks();
  resetSettings();
  resetRunNotifications();
  resetOpenRequests();
  addHost({ name: 'shop', hostname: 'shop', port: 22, username: 'deploy' });
  N.getPermissionsAsync.mockResolvedValue(GRANTED);
  N.requestPermissionsAsync.mockResolvedValue(GRANTED);
  let next = 1;
  N.scheduleNotificationAsync.mockImplementation(async () => `n${next++}`);
  appState = 'active';
  appListeners = [];
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appState });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appListeners.push(listener as (s: AppStateStatus) => void);
    return {
      remove: () => {
        appListeners = appListeners.filter((l) => l !== listener);
      },
    } as ReturnType<typeof AppState.addEventListener>;
  });
});

describe('a run while the app is in the background', () => {
  beforeEach(() => setNotifyRuns(true));

  it('done: the run bar’s words, opening at the top', async () => {
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 0 }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    appState = 'background';
    await runAll();
    await waitFor(() => expect(shownNow()).toEqual(['Deploy checkout: Done · 2 of 2']));
    expect(shownData()[0]).toEqual({ runbookId: rb.id });
    // Started while away: "paused" was scheduled first, and taken back when the run ended.
    expect(N.scheduleNotificationAsync.mock.calls[0]![0].content.title).toBe('Deploy checkout is paused in the background');
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('n1');
  });

  it('failed: the step and its name, and why Run all stopped; opening at that step', async () => {
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 1 }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    const push = parse(DEPLOY).cells.findIndex((c) => c.value === 'make push');
    await render(<RunbookView id={rb.id} />);
    appState = 'background';
    await runAll();
    await waitFor(() =>
      expect(shownNow()).toEqual([
        'Deploy checkout: Step 2 of 2 failed — Push image\nRun all stopped at a failed step: fix it, then Resume.',
      ]),
    );
    expect(shownData()[0]).toEqual({ runbookId: rb.id, cellIndex: push });
  });

  it('waits at a step done by hand: what it asks, opening at it', async () => {
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 0 }]);
    const rb = addRunbook('deploy.md', WITH_HAND_STEP);
    await render(<RunbookView id={rb.id} />);
    appState = 'background';
    await runAll();
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await waitFor(() => expect(shownNow()).toEqual(['Deploy checkout waits for you: Done by hand? Tell #checkout the deploy starts']));
    const item = parse(WITH_HAND_STEP).cells.findIndex((c) => c.value.includes('Tell #checkout'));
    expect(shownData()[0]).toEqual({ runbookId: rb.id, cellIndex: item });
  });

  it('going away mid-run schedules "paused"; the run ending first takes it back and says how it ended', async () => {
    mockConnection = fakeConnection([{ waitForAbort: true }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    const build = parse(DEPLOY).cells.findIndex((c) => c.value === 'make image');
    await render(<RunbookView id={rb.id} />);
    await runAll();
    await waitFor(() => expect(screen.getByTestId('run-primary')).toHaveTextContent('■ Stop'));
    await goTo('background');
    await waitFor(() => expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1));
    const [paused] = N.scheduleNotificationAsync.mock.calls[0]!;
    expect(paused.content).toEqual({
      title: 'Deploy checkout is paused in the background',
      body: 'Your phone pauses md-runbook soon after you leave it, so the step that was running may have been cut off. Open md-runbook to check it and go on.',
      data: { runbookId: rb.id, cellIndex: build },
    });
    expect(paused.trigger).toEqual({ type: 'timeInterval', seconds: PAUSED_AFTER_SECONDS, channelId: 'runs' });
    expect(PAUSED_AFTER_SECONDS).toBe(30); // iOS in Jest: about the background time it gets
    // The run ends while the app still runs in the background (here: stopped).
    await runAll();
    await waitFor(() => expect(shownNow()).toEqual(['Deploy checkout: Step 1 of 2 failed — Build image']));
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('n1');
    expect(N.dismissNotificationAsync).toHaveBeenCalledWith('n1');
  });

  it('back on screen before then: "paused" is taken back, and nothing else is shown', async () => {
    mockConnection = fakeConnection([{ waitForAbort: true }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await runAll();
    await goTo('background');
    await waitFor(() => expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1));
    await goTo('active');
    await waitFor(() => expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('n1'));
    await runAll(); // Stop, on screen
    await waitFor(() => expect(screen.getByTestId('run-primary')).not.toHaveTextContent('■ Stop'));
    expect(shownNow()).toEqual([]);
  });
});

describe('no notification', () => {
  it('while the app is on screen', async () => {
    setNotifyRuns(true);
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 1 }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await runAll();
    await waitFor(() => expect(screen.getByTestId('run-notice')).toBeTruthy());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('when turned off in the settings', async () => {
    setNotifyRuns(false);
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 1 }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    appState = 'background';
    await runAll();
    await waitFor(() => expect(screen.getByTestId('run-notice')).toBeTruthy());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('notify-offer')).toBeNull();
  });

  it('when the system refused them (turned off there later)', async () => {
    setNotifyRuns(true);
    N.getPermissionsAsync.mockResolvedValue(DENIED);
    mockConnection = fakeConnection([{ exitCode: 0 }, { exitCode: 1 }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    appState = 'background';
    await runAll();
    await waitFor(() => expect(screen.getByTestId('run-notice')).toBeTruthy());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('asking for the permission', () => {
  beforeEach(() => {
    N.getPermissionsAsync.mockResolvedValue(UNDETERMINED);
    mockConnection = fakeConnection([{ exitCode: 0 }]);
  });

  it('not when the app opens a runbook: at the first Run all, with what for; asked once', async () => {
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    expect(screen.queryByTestId('notify-offer')).toBeNull();
    await runAll();
    await waitFor(() => expect(screen.getByTestId('notify-offer')).toBeTruthy());
    expect(screen.getByText('Get a notification when this run needs you?')).toBeTruthy();
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-offer-yes'));
    });
    await waitFor(() => expect(notifyRuns()).toBe(true));
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('notify-offer')).toBeNull();
    // The next Run all doesn't ask again.
    await waitFor(() => expect(screen.getByTestId('run-primary')).toHaveTextContent('↻ Run again'));
    await runAll();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByTestId('notify-offer')).toBeNull();
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('Not now, or a no from the system: never offered again', async () => {
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await runAll();
    await waitFor(() => expect(screen.getByTestId('notify-offer')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-offer-no'));
    });
    expect(notifyRuns()).toBe(false);
    await waitFor(() => expect(screen.getByTestId('run-primary')).toHaveTextContent('↻ Run again'));
    await runAll();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByTestId('notify-offer')).toBeNull();
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();

    // The system says no to Notify me: off, and not offered again either.
    resetSettings();
    N.requestPermissionsAsync.mockResolvedValue(DENIED);
    await waitFor(() => expect(screen.getByTestId('run-primary')).toHaveTextContent('↻ Run again'));
    await runAll();
    await waitFor(() => expect(screen.getByTestId('notify-offer')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-offer-yes'));
    });
    await waitFor(() => expect(notifyRuns()).toBe(false));
  });

  it('already refused in the system: not offered, and off', async () => {
    N.getPermissionsAsync.mockResolvedValue(DENIED);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await runAll();
    await waitFor(() => expect(notifyRuns()).toBe(false));
    expect(screen.queryByTestId('notify-offer')).toBeNull();
  });
});

describe('the setting (Hosts & settings → Notifications)', () => {
  it('on: asks the system if it hasn’t been; a no leaves it off and says where to allow them; off: off', async () => {
    N.getPermissionsAsync.mockResolvedValue(UNDETERMINED);
    await render(<HostList />);
    expect(screen.getByTestId('setting-notifyRuns')).toHaveProp('accessibilityState', expect.objectContaining({ checked: false }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('setting-notifyRuns'));
    });
    await waitFor(() => expect(notifyRuns()).toBe(true));
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(screen.getByTestId('setting-notifyRuns'));
    });
    expect(notifyRuns()).toBe(false);
    // Turned off in the system since.
    N.getPermissionsAsync.mockResolvedValue(DENIED);
    await act(async () => {
      fireEvent.press(screen.getByTestId('setting-notifyRuns'));
    });
    await waitFor(() => expect(screen.getByTestId('notify-blocked')).toBeTruthy());
    expect(notifyRuns()).toBe(false);
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('notify-open-settings')).toBeTruthy();
  });
});

describe('tapping a notification', () => {
  function Taps() {
    useNotificationTaps();
    return null;
  }
  const tap = async (data: Record<string, unknown>, id = 'tap-1'): Promise<void> => {
    const listener = N.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
    await act(async () => {
      listener({
        actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
        notification: { request: { identifier: id, content: { data } } },
      } as unknown as Notifications.NotificationResponse);
    });
  };

  it('opens the runbook and scrolls to the step', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<Taps />);
    await tap({ runbookId: rb.id, cellIndex: 2 });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: rb.id } });
    // The screen it opens goes to the step.
    await render(<RunbookView id={rb.id} />);
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ index: 2, viewPosition: 0.2 }));
    scroll.mockRestore();
  });

  it('the app started from the tap: the same', async () => {
    const rb = addRunbook('deploy.md', DEPLOY);
    N.getLastNotificationResponse.mockReturnValueOnce({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: { request: { identifier: 'launch', content: { data: { runbookId: rb.id } } } },
    } as unknown as Notifications.NotificationResponse);
    await render(<Taps />);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: rb.id } });
    expect(N.clearLastNotificationResponse).toHaveBeenCalled();
    // The same tap again (the listener may get it too): opened once.
    await tap({ runbookId: rb.id }, 'launch');
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('ignores a notification that names no runbook', async () => {
    await render(<Taps />);
    await tap({ something: 'else' });
    expect(router.push).not.toHaveBeenCalled();
  });
});

/**
 * Alerts on this phone (notifications/alertPush.ts, screens/AlertPushSettings.tsx): registering
 * the native push token with the team library server, turning it off, a tap opening the alert's
 * link through openRunbookLink (only links of the registered server), a rolled token registered
 * again, and a build without push set up saying so and doing nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import {
  alertLinkOf,
  alertRegistration,
  openAlertTap,
  refreshAlertPush,
  resetAlertPush,
  turnOffAlertPush,
  turnOnAlertPush,
} from '../notifications/alertPush';
import '../notifications/platform';
import { openRunbookLink } from '../runbooks/openLink';
import { AlertPushSettings } from '../screens/AlertPushSettings';
import { resetSettings, setLibraryUrl } from '../settings/store';
import { getSecret } from '../storage/secure';

const mockPush = { ios: true, android: true };
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: { push: mockPush } };
    },
  },
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../runbooks/openLink', () => ({ openRunbookLink: jest.fn() }));

const N = jest.mocked(Notifications);
const LIBRARY = 'https://runbooks.example.net/runbooks/';
const SERVER = 'https://runbooks.example.net';
const ID = '0123456789abcdef0123456789abcdef';
const DEVICES = 'devices-token-of-at-least-24-chars';
const LINK = `${SERVER}/open?url=${encodeURIComponent(`${LIBRARY}k8s/crashloop.md`)}&p.NAMESPACE=prod-eu`;

const answer = (status: number, body: unknown): Response => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
const fetcherOf = (...answers: Response[]) => jest.fn(async (..._args: Parameters<typeof fetch>) => answers.shift() ?? answer(500, {}));

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAlertPush();
  resetSettings();
  mockPush.ios = true;
  mockPush.android = true;
  jest.mocked(router.push).mockClear();
  jest.mocked(openRunbookLink).mockReset();
});

describe('alerts on this phone', () => {
  it('registers the native push token with the library server, with the devices token', async () => {
    const f = fetcherOf(answer(201, { id: ID, platform: 'ios' }));
    expect(await turnOnAlertPush(LIBRARY, ` ${DEVICES} `, f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/v1/devices`);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${DEVICES}`);
    expect(JSON.parse(init!.body as string)).toEqual({ platform: 'ios', token: 'a'.repeat(64) });
    expect(alertRegistration()).toEqual({ server: SERVER, id: ID, platform: 'ios', pushToken: 'a'.repeat(64) });
    expect(await getSecret('alertPush.devicesToken')).toBe(DEVICES);
  });

  it('says why it is not on: the server refused, notifications blocked, no library, no token', async () => {
    expect(
      await turnOnAlertPush(
        LIBRARY,
        DEVICES,
        fetcherOf(answer(401, { error: 'registering for pushes: the token is not one this server accepts' })),
      ),
    ).toEqual({
      ok: false,
      message: 'Not turned on: registering for pushes: the token is not one this server accepts',
    });
    expect(alertRegistration()).toBeUndefined();
    N.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied', granted: false, canAskAgain: false, expires: 'never' } as never);
    expect(await turnOnAlertPush(LIBRARY, DEVICES, fetcherOf())).toMatchObject({ ok: false, blocked: true });
    expect(await turnOnAlertPush(undefined, DEVICES, fetcherOf())).toMatchObject({ ok: false });
    expect(await turnOnAlertPush('http://localhost:8080/runbooks/', DEVICES, fetcherOf())).toMatchObject({ ok: false });
    expect(await turnOnAlertPush(LIBRARY, '  ', fetcherOf())).toMatchObject({ ok: false });
  });

  it('turning it off forgets it here and tells the server', async () => {
    await turnOnAlertPush(LIBRARY, DEVICES, fetcherOf(answer(201, { id: ID })));
    const f = fetcherOf(answer(200, { deleted: ID }));
    expect(await turnOffAlertPush(f)).toEqual({ ok: true });
    expect(f.mock.calls[0]![0]).toBe(`${SERVER}/v1/devices/${ID}`);
    expect(f.mock.calls[0]![1]!.method).toBe('DELETE');
    expect(alertRegistration()).toBeUndefined();
    expect(await getSecret('alertPush.devicesToken')).toBeNull();
  });

  it('a tap opens the alert link of the registered server only, through openRunbookLink', async () => {
    await turnOnAlertPush(LIBRARY, DEVICES, fetcherOf(answer(201, { id: ID })));
    const reg = alertRegistration();
    expect(alertLinkOf({ kind: 'alert', link: LINK }, reg)).toBe(LINK);
    expect(alertLinkOf({ kind: 'alert', link: LINK.replace('runbooks.example.net/open', 'evil.example.net/open') }, reg)).toBeUndefined();
    expect(alertLinkOf({ kind: 'alert', link: LINK.replace('https:', 'http:') }, reg)).toBeUndefined();
    expect(alertLinkOf({ kind: 'alert', link: `${SERVER}/runbooks/x.md` }, reg)).toBeUndefined();
    expect(alertLinkOf({ link: LINK }, reg)).toBeUndefined();
    expect(alertLinkOf({ kind: 'alert', link: LINK }, undefined)).toBeUndefined();

    jest.mocked(openRunbookLink).mockResolvedValueOnce({ kind: 'opened', runbook: { id: 'rb-1' } as never });
    await openAlertTap({ kind: 'alert', alertname: 'KubePodCrashLooping', link: LINK });
    expect(openRunbookLink).toHaveBeenCalledWith(LINK, undefined);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: 'rb-1' } });

    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest
      .mocked(openRunbookLink)
      .mockResolvedValueOnce({ kind: 'error', message: 'Not opened: it isn’t the runbook this link pins (sha256=).' });
    await openAlertTap({ kind: 'alert', link: LINK });
    expect(alert).toHaveBeenCalledWith('The alert’s runbook didn’t open', 'Not opened: it isn’t the runbook this link pins (sha256=).');
    // Another server's link, or a run's notification: nothing opens.
    await openAlertTap({ kind: 'alert', link: 'https://evil.example.net/open?url=https%3A%2F%2Fevil.example.net%2Fx.md' });
    await openAlertTap({ runbookId: 'x' });
    expect(openRunbookLink).toHaveBeenCalledTimes(2);
    alert.mockRestore();
  });

  it('a new push token is registered again, the old device removed', async () => {
    await turnOnAlertPush(LIBRARY, DEVICES, fetcherOf(answer(201, { id: ID })));
    const NEW_ID = 'f'.repeat(32);
    const f = fetcherOf(answer(201, { id: NEW_ID }), answer(200, { deleted: ID }));
    await refreshAlertPush('b'.repeat(64), f);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ platform: 'ios', token: 'b'.repeat(64) });
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(f.mock.calls[1]![0]).toBe(`${SERVER}/v1/devices/${ID}`);
    expect(alertRegistration()).toMatchObject({ id: NEW_ID, pushToken: 'b'.repeat(64) });
    // The same token: nothing sent.
    const g = fetcherOf();
    await refreshAlertPush('b'.repeat(64), g);
    expect(g).not.toHaveBeenCalled();
  });

  it('alert pushes show in the foreground; run notifications do not', async () => {
    const handler = N.setNotificationHandler.mock.calls[0]![0]!;
    const of = (data: Record<string, unknown>) => handler.handleNotification({ request: { content: { data } } } as never);
    expect(await of({ kind: 'alert', link: LINK })).toMatchObject({ shouldShowBanner: true, shouldPlaySound: true });
    expect(await of({ runbookId: 'x' })).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });
  });
});

describe('Alerts on this phone, the card', () => {
  it('a build without push set up says so and the switch does nothing', async () => {
    mockPush.ios = false;
    N.getDevicePushTokenAsync.mockClear();
    setLibraryUrl(LIBRARY);
    const f = fetcherOf();
    await render(<AlertPushSettings fetcher={f} />);
    expect(screen.getByTestId('alert-push-unavailable')).toHaveTextContent('Not set up in this build.');
    expect(screen.queryByTestId('alert-push-token')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('alert-push-switch'));
    });
    expect(f).not.toHaveBeenCalled();
    expect(N.getDevicePushTokenAsync).not.toHaveBeenCalled();
  });

  it('asks for the team library first', async () => {
    await render(<AlertPushSettings fetcher={fetcherOf()} />);
    expect(screen.getByTestId('alert-push-no-library')).toBeTruthy();
  });

  it('turns on with the token typed, then off', async () => {
    setLibraryUrl(LIBRARY);
    const f = fetcherOf(answer(201, { id: ID }), answer(200, { deleted: ID }));
    await render(<AlertPushSettings fetcher={f} />);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('alert-push-token'), DEVICES);
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('alert-push-switch'));
    });
    expect(await screen.findByTestId('alert-push-on')).toHaveTextContent('On: alerts from runbooks.example.net come to this phone.');
    expect(screen.queryByTestId('alert-push-token')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('alert-push-switch'));
    });
    await waitFor(() => expect(screen.queryByTestId('alert-push-on')).toBeNull());
    expect(f).toHaveBeenCalledTimes(2);
  });
});

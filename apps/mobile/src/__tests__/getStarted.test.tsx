/**
 * Get Started (ui/GetStarted.tsx): a short tour on the start screen, by itself on the first start
 * until skipped or done, and again from the start screen's ⋯.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { t } from '../i18n';
import { RunbookList } from '../screens/RunbookList';
import { loadSettings, outputSettings, resetSettings, setOutputSetting } from '../settings/store';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => unknown } }) => options?.headerRight?.() ?? null },
  router: { push: jest.fn(), back: jest.fn() },
}));
const push = router.push as jest.Mock;

beforeEach(async () => {
  resetSettings();
  // A first start: the device's storage (kept between tests) says nothing was seen.
  await loadSettings();
  setOutputSetting('tourSeen', false);
  push.mockClear();
});

const press = async (id: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};

describe('Get Started', () => {
  it('shows by itself on the first start: a few cards, each a title and points', async () => {
    await render(<RunbookList />);
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Runbooks you can run');
    expect(screen.getByTestId('tour-step')).toHaveTextContent(`Get started · 1 of ${t.tourCards.length}`);
    expect(t.tourCards.length).toBeGreaterThanOrEqual(3);
    expect(t.tourCards.length).toBeLessThanOrEqual(5);
    for (const c of t.tourCards) expect(c.points.length).toBeLessThanOrEqual(3);
    await press('tour-action-sample');
    expect(push).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: 'sample' } });
    await press('tour-next');
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Run a step');
    await press('tour-back');
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Runbooks you can run');
    await press('tour-next');
    await press('tour-next');
    await press('tour-action-hosts');
    expect(push).toHaveBeenLastCalledWith('/hosts');
    for (let i = 3; i < t.tourCards.length; i++) await press('tour-next');
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Where help is');
    await press('tour-done');
    expect(screen.queryByTestId('tour')).toBeNull();
    expect(outputSettings().tourSeen).toBe(true);
  });

  it('skipped, it doesn’t come back by itself; the start screen’s ⋯ shows it again', async () => {
    await render(<RunbookList />);
    await press('tour-skip');
    expect(screen.queryByTestId('tour')).toBeNull();
    expect(outputSettings().tourSeen).toBe(true);
    await press('home-more');
    await press('action-getStarted');
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Runbooks you can run');
  });

  it('seen before: not shown at the start', async () => {
    setOutputSetting('tourSeen', true);
    await render(<RunbookList />);
    expect(screen.queryByTestId('tour')).toBeNull();
  });
});

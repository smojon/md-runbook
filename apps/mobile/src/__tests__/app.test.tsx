import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { pinnedIds, resetPins } from '../runbooks/pins';
import { checkCore } from '../coreCheck';
import { RunbookList } from '../screens/RunbookList';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => {
  const { Fragment } = jest.requireActual('react');
  return { Link: ({ children }: { children: unknown }) => children, Stack: { Screen: () => null }, Fragment };
});

describe('the shared core in the app', () => {
  it('round-trips the sample and runs RE2 checks', () => {
    expect(checkCore()).toEqual({ ok: true });
  });
});

describe('screens', () => {
  it('lists the sample runbook, with no core error', async () => {
    await render(<RunbookList />);
    expect(screen.getByTestId('runbook-sample')).toBeTruthy();
    expect(screen.getByText('2 commands · Example')).toBeTruthy();
    expect(screen.queryByTestId('core-error')).toBeNull();
  });

  it('shows the cells of a runbook with their saved output', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByText(/uptime/)).toBeTruthy();
    expect(screen.getByTestId('cell-1-output')).toBeTruthy();
  });

  it('says when a runbook does not exist', async () => {
    await render(<RunbookView id="nope" />);
    expect(screen.getByTestId('runbook-not-found')).toBeTruthy();
  });

  it('copes with a large runbook', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `Step ${i}\n\n\`\`\`bash\necho ${i}\n\`\`\`\n`).join('\n');
    expect(checkCore(big)).toEqual({ ok: true });
  });
});

describe('pinned runbooks', () => {
  it('a pinned runbook moves to the top under "Pinned"; unpinning moves it back', async () => {
    resetPins();
    await render(<RunbookList />);
    expect(screen.queryByText('Pinned')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('pin-sample'));
    });
    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByTestId('pin-sample').props.accessibilityState).toMatchObject({ selected: true });
    expect(pinnedIds()).toEqual(['sample']);
    await act(async () => {
      fireEvent.press(screen.getByTestId('pin-sample'));
    });
    expect(screen.queryByText('Pinned')).toBeNull();
    expect(pinnedIds()).toEqual([]);
  });
});

/**
 * Every action in sight: a Steps row's ⋯ (besides the long press), the start screen's ⋯ sheet,
 * the hint that a cell's lines have actions (until the first tap on one), and Reject Proposed
 * Cell in a proposal's ⋯.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { parse } from '@md-runbook/core';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import type { StepsRow } from '../runbooks/steps';
import { RunbookList } from '../screens/RunbookList';
import { RunbookView } from '../screens/RunbookView';
import { outputSettings, resetSettings } from '../settings/store';
import { StepsList } from '../ui/StepsList';
import { CHEAT_SHEET_URL } from '../helpLinks';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  // The header's buttons, drawn where the screen sets them.
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => unknown } }) => options?.headerRight?.() ?? null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
const push = router.push as jest.Mock;

beforeEach(() => {
  resetSettings();
  resetHosts();
  resetRunbooks();
  push.mockClear();
});

describe('a Steps row’s actions', () => {
  const rows: StepsRow[] = [
    { kind: 'step', key: '1', index: 1, step: 1, label: 'Deploy', state: 'pending' },
    { kind: 'step', key: '3-0', index: 3, item: 0, step: 2, label: 'Call the DBA', state: 'pending' },
  ];

  it('open from its ⋯ and from a long press; a checklist item has none', async () => {
    const onActions = jest.fn();
    await render(<StepsList rows={rows} onGo={jest.fn()} onActions={onActions} onTick={jest.fn()} />);
    expect(screen.getByTestId('steps-actions-1')).toHaveProp('accessibilityLabel', 'Actions of Deploy');
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-actions-1'));
    });
    await act(async () => {
      fireEvent(screen.getByTestId('steps-row-1'), 'longPress');
    });
    expect(onActions.mock.calls).toEqual([[1], [1]]);
    expect(screen.queryByTestId('steps-actions-3-0')).toBeNull();
  });
});

describe('the start screen’s ⋯', () => {
  it('has the start screen’s actions and the help', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<RunbookList />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('home-more'));
    });
    for (const id of ['openFile', 'scanCode', 'openLink', 'newRunbook', 'sample', 'cheatSheet', 'hosts'])
      expect(screen.getByTestId(`action-${id}`)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-sample'));
    });
    expect(push).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: 'sample' } });
    await act(async () => {
      fireEvent.press(screen.getByTestId('home-more'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-cheatSheet'));
    });
    expect(open).toHaveBeenCalledWith(CHEAT_SHEET_URL);
    await act(async () => {
      fireEvent.press(screen.getByTestId('home-more'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-openLink'));
    });
    expect(screen.getByTestId('open-link-url')).toBeTruthy();
    open.mockRestore();
  });
});

describe('a cell’s lines', () => {
  it('say they have actions until a line is tapped once', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId('cell-1-line-hint')).toHaveTextContent(/Tap a line for its actions/);
    expect(screen.getByTestId('cell-1-line-0')).toHaveProp('accessibilityHint', 'Shows this command’s actions');
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-0'));
    });
    expect(outputSettings().lineHintSeen).toBe(true);
    expect(screen.queryByTestId('cell-1-line-hint')).toBeNull();
  });
});

describe('a proposal’s ⋯', () => {
  it('has Reject Proposed Cell: the cell leaves the runbook', async () => {
    const rb = addRunbook('x.md', '# X\n\n```bash proposed by=ai reason="look"\nkubectl get pods\n```\n\n```bash\necho mine\n```\n');
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-rejectProposal'));
    });
    await waitFor(() => expect(getRunbook(rb.id)?.text).not.toContain('kubectl get pods'));
    expect(parse(getRunbook(rb.id)!.text).cells.filter((c) => c.kind === 'code')).toHaveLength(1);
  });
});

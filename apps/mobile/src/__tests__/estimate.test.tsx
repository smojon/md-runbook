import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { addHost, resetHosts } from '../hosts/store';
import { learnedFor, recordStepRun, stepHistoryOf } from '../runbooks/history';
import { addRunbook, resetRunbooks } from '../runbooks/store';
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

beforeEach(() => {
  resetHosts();
  resetRunbooks();
});

const DONE = '<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';

describe('estimate= (how long a cell takes)', () => {
  it('shows on the cell, and the top says how far the runbook is by the estimates', async () => {
    const r = addRunbook(
      'est.md',
      `# Steps\n\n\`\`\`bash estimate=2m30s\necho one\n\`\`\`\n${DONE}\n\`\`\`bash\necho two\n\`\`\`\n\n\`\`\`bash estimate=3m30s\necho three\n\`\`\`\n`,
    );
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('cell-1-estimate')).toHaveTextContent(/est\. 2m30s$/);
    expect(screen.queryByTestId('cell-2-estimate')).toBeNull();
    expect(screen.getByTestId('run-estimate-text')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^at least 4 min left · 1 block without an estimate$/),
    );
    // On screen, in words: how far, how long, when it ends; then what has no estimate.
    expect(screen.getByTestId('estimate-main')).toHaveTextContent(/^at least 4 min left$/);
    expect(screen.getByTestId('estimate-more')).toHaveTextContent('1 block without an estimate');
  });

  it('a cell without estimate= learns its usual time from its runs that passed (~, not in the file)', async () => {
    mockConnection = fakeConnection([{ stdout: 'one\n' }]);
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const r = addRunbook('learn.md', '# Steps\n\n```bash\necho one\n```\n');
    await render(<RunbookView id={r.id} />);
    expect(screen.queryByTestId('cell-1-estimate')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-estimate')).toHaveTextContent(/est\. ~[1-9]s$/));
    expect(screen.queryByTestId('estimate-more')).toBeNull();
    // The output line doesn't compare the run with an estimate it was learned from.
    expect(screen.queryByTestId('cell-1-took')).toBeNull();
  });

  it('⋯ More → Forget Learned Times asks first, then forgets this runbook’s times only', async () => {
    await recordStepRun('other', '', 'echo other', 30);
    const r = addRunbook('forget.md', '# Steps\n\n```bash\necho one\n```\n');
    await recordStepRun(r.id, '', 'echo one', 20);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('cell-1-estimate')).toHaveTextContent(/est\. ~20s$/);
    const more = async (id: string): Promise<void> => {
      await act(async () => {
        fireEvent.press(screen.getByTestId('more-actions'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId(`action-${id}`));
      });
    };
    // Cancel keeps them.
    let answer: 'Cancel' | 'Forget' = 'Cancel';
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((b) => b.text === answer)?.onPress?.();
    });
    await more('forgetLearnedTimes');
    expect(alert).toHaveBeenLastCalledWith(expect.stringMatching(/^Forget the learned times of Steps\?/), undefined, expect.any(Array));
    expect(screen.getByTestId('cell-1-estimate')).toHaveTextContent(/est\. ~20s$/);
    answer = 'Forget';
    await more('forgetLearnedTimes');
    await waitFor(() => expect(screen.queryByTestId('cell-1-estimate')).toBeNull());
    expect(learnedFor(stepHistoryOf('other'), '', 'echo other')).toBe(30);
    // Nothing left to forget here: greyed out, with why.
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    expect(screen.getByTestId('action-forgetLearnedTimes')).toHaveProp('accessibilityState', { disabled: true });
    // Every runbook's: the other one's go too.
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-forgetAllLearnedTimes'));
    });
    await waitFor(() => expect(stepHistoryOf('other')).toBeUndefined());
    alert.mockRestore();
  });

  it('says nothing about estimates in a runbook without any', async () => {
    const r = addRunbook('plain.md', '# Steps\n\n```bash\necho one\n```\n');
    await render(<RunbookView id={r.id} />);
    expect(screen.queryByTestId('run-estimate')).toBeNull();
    expect(screen.queryByTestId('cell-1-estimate')).toBeNull();
  });

  it('a running cell shows a bar against its estimate, and how much over once past it', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ waitForAbort: true }]);
    const r = addRunbook('slow.md', '# Steps\n\n```bash estimate=1\nsleep 100\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    // One line: Running · 0s of 1s, the bar under it.
    await waitFor(() => expect(screen.getByTestId('cell-1-timing-text')).toHaveTextContent(/ \d+s of 1s$/));
    expect(screen.getByTestId('cell-1-timing')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('cell-1-timing-text')).toHaveTextContent(/\+\d+s over 1s$/), { timeout: 5000 });
    expect(screen.getByTestId('run-estimate-text')).toHaveProp('accessibilityLabel', '99% · 1 step left');
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Step 1 of 1 · sleep 100');
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
    await waitFor(() => expect(screen.queryByTestId('cell-1-timing')).toBeNull());
  });
});

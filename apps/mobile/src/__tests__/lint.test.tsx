import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { fixCellOption, runbookProblems } from '../runbooks/lint';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(),
  disconnect: jest.fn(async () => undefined),
  isConnected: jest.fn(() => false),
}));

beforeEach(() => resetRunbooks());

const infoOf = (text: string, cell: number): string | undefined => {
  const meta = parse(text).cells[cell]?.meta as { info?: string } | undefined;
  return meta?.info;
};

// Cell 1: a misspelled option with a suggestion; cell 2: ${out:VERSION} never captured.
const TYPOS = [
  '---',
  'mode: sometimes',
  '---',
  '# Deploy',
  '',
  '```bash retires=3 every=5s',
  'curl -f https://example.com/health',
  '```',
  '',
  '```bash',
  'echo ${out:VERSION}',
  '```',
  '',
].join('\n');

describe('runbookProblems', () => {
  it("puts a code block's problems on its cell and the front matter's on the runbook", () => {
    const p = runbookProblems(TYPOS);
    expect(p.runbook.map((x) => x.message)).toEqual(['front matter mode: "sometimes" is ignored (expected session or isolated)']);
    expect([...p.byCell.keys()]).toEqual([1, 2]);
    expect(p.byCell.get(1)!.map((x) => x.message)).toEqual([
      'unknown cell option "retires" (ignored): did you mean "retry"?',
      'every= has no effect without retry=',
    ]);
    expect(p.byCell.get(1)![0]!.fix).toEqual({ option: 'retires', to: 'retry' });
    expect(p.byCell.get(2)![0]!.cell).toEqual({ index: 2, sourceLine: 0 });
    expect(p.all).toHaveLength(4);
  });

  it('finds nothing in a clean runbook', () => {
    expect(runbookProblems('# Fine\n\n```bash retry=3 every=5s\necho ok\n```\n').all).toEqual([]);
  });
});

describe('fixCellOption', () => {
  it('renames the option on the fence and keeps its value and the rest of the file', () => {
    const fixed = fixCellOption(TYPOS, 1, 'retires', 'retry')!;
    expect(infoOf(fixed, 1)).toBe('bash retry=3 every=5s');
    expect(fixed).toContain('mode: sometimes');
    expect(fixed).toContain('echo ${out:VERSION}');
    expect(runbookProblems(fixed).byCell.get(1)).toBeUndefined();
  });

  it('only fixes a typo to its suggestion: never turns one option into another', () => {
    const text = '# Risky\n\n```bash confirm retires=2\nrm -rf /tmp/x\n```\n';
    expect(fixCellOption(text, 1, 'confirm', 'continue-on-error')).toBeUndefined();
    expect(fixCellOption(text, 1, 'retires', 'timeout')).toBeUndefined();
    expect(fixCellOption(text, 0, 'retires', 'retry')).toBeUndefined();
    expect(fixCellOption(text, 1, 'retries', 'retry')).toBeUndefined(); // not on this cell
  });
});

describe('problems in the runbook view', () => {
  it('shows each problem under its cell, marks the line, and the fix renames the option', async () => {
    const r = addRunbook('deploy.md', TYPOS);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('cell-1-problems')).toHaveTextContent(/did you mean "retry"\?/);
    expect(screen.getByTestId('cell-2-problems')).toHaveTextContent(/Line 1 · \$\{out:VERSION\} is not captured/);
    expect(screen.getByTestId('cell-2-line-0-problem')).toBeTruthy();
    expect(screen.queryByTestId('cell-2-problem-0-fix')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-problem-0-fix'));
    });
    expect(infoOf(getRunbook(r.id)!.text, 1)).toBe('bash retry=3 every=5s');
    // With retry= understood, every= counts too: the cell has nothing left to report.
    expect(screen.queryByTestId('cell-1-problems')).toBeNull();
    expect(screen.getByTestId('cell-2-problems')).toBeTruthy();
  });

  it('counts the problems at the top, folded; opened, it lists them all with the fixes', async () => {
    const r = addRunbook('deploy.md', TYPOS);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('problems-summary')).toHaveTextContent('1 error, 3 warnings');
    expect(screen.queryByTestId('problems-0')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('problems-toggle'));
    });
    expect(screen.getByTestId('problems-0')).toHaveTextContent(/Line 2 · front matter mode: "sometimes" is ignored/);
    expect(screen.getByTestId('problems-1')).toHaveTextContent(/Cell 2 · unknown cell option "retires"/);
    expect(screen.getByTestId('problems-3')).toHaveTextContent(/Cell 3, line 1 · \$\{out:VERSION\}/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('problems-1-fix'));
    });
    expect(infoOf(getRunbook(r.id)!.text, 1)).toBe('bash retry=3 every=5s');
    expect(screen.getByTestId('problems-summary')).toHaveTextContent('1 error, 1 warning');
  });

  it('has no card for a clean runbook, and Go to Next Problem says why it is off', async () => {
    const r = addRunbook('fine.md', '# Fine\n\n```bash\necho ok\n```\n');
    await render(<RunbookView id={r.id} />);
    expect(screen.queryByTestId('problems-card')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    expect(screen.getByTestId('action-nextProblem').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  it('Go to Next Problem opens the card for the front matter, then goes to each cell', async () => {
    const r = addRunbook('deploy.md', TYPOS);
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-nextProblem'));
    });
    expect(screen.getByTestId('problems-0')).toBeTruthy();
  });
});

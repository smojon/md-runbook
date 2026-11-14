/**
 * The steps by name (as VS Code's Runbook Steps view): the Steps sheet from the run bar's headline
 * and the rail, the rail as a scrubber, the side panel on a wide screen; and Run all waiting at a
 * step done by hand (an unticked checklist item).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { stepsRows, uncheckedBefore, withItemTicked } from '../runbooks/steps';
import { RunbookView } from '../screens/RunbookView';
import { FakeRun, fakeConnection } from '../testing/fakeConnection';
import { parse } from '@md-runbook/core';
import { textProgress } from '@md-runbook/core/textProgress';

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
let mockWidth = 390;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 800, scale: 2, fontScale: 1 }),
}));

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const script = (runs: FakeRun[]) => (mockConnection = fakeConnection(runs));
const sources = (): string[] => mockConnection.calls.map((c) => c.source);

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  mockWidth = 390;
  addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
});

// Cells: 0 "# Guide", 1 a block, 2 "## Check" with a ticked item, 3 a block.
const GUIDE = [
  '# Guide',
  '',
  fence('bash name="Say hello" estimate=2m', 'echo one'),
  '## Check',
  '',
  '- [x] Look at the dashboard',
  '',
  fence('bash', 'echo two'),
].join('\n');

describe('the Steps sheet', () => {
  it('opens from the run bar’s headline, lists chapters and steps by name in their state, and a row closes it', async () => {
    script([{ stdout: 'one\n' }, { stderr: 'boom\n', exitCode: 1 }]);
    const rb = addRunbook('guide.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.queryByTestId('steps-sheet')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-progress'));
    });
    expect(screen.getByTestId('steps-sheet')).toBeTruthy();
    // The header says what the run bar says.
    expect(screen.getByTestId('steps-headline')).toHaveTextContent('1 of 3 steps done');
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^0% · 2 min left/);
    expect(screen.getByTestId('steps-chapter-0')).toHaveTextContent('Guide');
    expect(screen.getByTestId('steps-chapter-2')).toHaveTextContent('Check');
    expect(screen.getByTestId('steps-row-1')).toHaveProp('accessibilityLabel', 'Step 1: Say hello, to do, est. 2m');
    expect(screen.getByTestId('steps-state-1')).toHaveTextContent('○');
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', 'Step 2: Look at the dashboard, done, by hand');
    expect(screen.getByTestId('steps-state-2')).toHaveTextContent('✓');
    expect(screen.getByTestId('steps-row-3')).toHaveProp('accessibilityLabel', 'Step 3: echo two, to do');
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-close'));
    });
    expect(screen.queryByTestId('steps-sheet')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('run-progress')).toHaveTextContent('Step 3 of 3 failed'));
    // ⋯ More → Show Steps opens it too.
    await act(async () => {
      fireEvent.press(screen.getByTestId('more-actions'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('action-showSteps'));
    });
    expect(screen.getByTestId('steps-headline')).toHaveTextContent('Step 3 of 3 failed');
    expect(screen.getByTestId('steps-row-1')).toHaveProp('accessibilityLabel', expect.stringMatching(/^Step 1: Say hello, done, took /));
    expect(screen.getByTestId('steps-state-3')).toHaveTextContent('✕');
    expect(screen.getByTestId('steps-row-3')).toHaveProp('accessibilityLabel', expect.stringMatching(/^Step 3: echo two, failed/));
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-row-3'));
    });
    expect(screen.queryByTestId('steps-sheet')).toBeNull();
  });

  it('a running step shows ▶ and its time against the estimate; one waiting for you shows ❚❚', async () => {
    const rb = addRunbook('rows.md', GUIDE);
    const cells = parse(getRunbook(rb.id)!.text).cells;
    const progress = textProgress(getRunbook(rb.id)!.text);
    const now = 1_000_000;
    const rows = stepsRows({ cells, progress, running: { cellIndex: 1, startedAt: now - 12_000 }, now });
    expect(rows.find((r) => r.key === '1')).toMatchObject({ state: 'running', time: '12s of 2m', fraction: 0.1 });
    const waiting = stepsRows({ cells, progress, waiting: { cellIndex: 3 }, now });
    expect(waiting.find((r) => r.key === '3')).toMatchObject({ state: 'waiting' });
  });

  it('names the ready check by what it answered and the teardown as offered', () => {
    const text = [
      '# Lab',
      '',
      fence('bash ready name="the lab"', 'test -f up') +
        '<!-- md-runbook:output start exit=0 check=ok ready=up -->\n```text\nup\n```\n<!-- md-runbook:output end -->',
      '',
      fence('bash', 'echo work'),
      '',
      fence('bash teardown name="Stop the lab" estimate=2m', 'rm up'),
    ].join('\n');
    const rows = stepsRows({ cells: parse(text).cells, progress: textProgress(text), now: 0 });
    expect(rows.filter((r) => r.kind === 'step').map((r) => [r.label, r.kind === 'step' ? (r.time ?? '') : ''])).toEqual([
      ['Ready check: the lab', 'already up'],
      ['echo work', ''],
      ['Stop the lab (teardown, offered)', 'est. 2m'],
    ]);
  });
});

describe('the rail as a scrubber', () => {
  it('a tap shows the steps; press and drag shows the chapter and step at the finger; letting go goes there', async () => {
    const rb = addRunbook('scrub.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    const rail = screen.getByTestId('progress-rail');
    expect(rail).toHaveProp('accessibilityHint', 'Shows the steps. Drag along the rail to go to a step.');
    // 4 cells over 400 px: their marks at 50, 150, 250 and 350.
    await act(async () => {
      fireEvent(rail, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 44, height: 400 } } });
    });
    // A plain tap: the Steps sheet.
    await act(async () => {
      fireEvent(rail, 'responderGrant', { nativeEvent: { locationY: 40, pageY: 140 } });
      fireEvent(rail, 'responderRelease', { nativeEvent: { locationY: 40, pageY: 140 } });
    });
    expect(screen.getByTestId('steps-sheet')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-close'));
    });
    // Press and drag down: the bubble follows the finger.
    await act(async () => {
      fireEvent(rail, 'responderGrant', { nativeEvent: { locationY: 40, pageY: 140 } });
      fireEvent(rail, 'responderMove', { nativeEvent: { locationY: 0, pageY: 145 } });
    });
    // Not yet a drag (under 8 px): no bubble.
    expect(screen.queryByTestId('rail-bubble')).toBeNull();
    // At 50: the chapter's crossbar is nearest.
    await act(async () => {
      fireEvent(rail, 'responderMove', { nativeEvent: { locationY: 0, pageY: 150 } });
    });
    expect(screen.getByTestId('rail-bubble-chapter')).toHaveTextContent('Guide');
    expect(screen.queryByTestId('rail-bubble-step')).toBeNull();
    // At 130: step 1, in its chapter.
    await act(async () => {
      fireEvent(rail, 'responderMove', { nativeEvent: { locationY: 0, pageY: 230 } });
    });
    expect(screen.getByTestId('rail-bubble-chapter')).toHaveTextContent('Guide');
    expect(screen.getByTestId('rail-bubble-step')).toHaveTextContent('1 · Say hello');
    // At 350: step 3 (the checklist item is step 2), in the next chapter.
    await act(async () => {
      fireEvent(rail, 'responderMove', { nativeEvent: { locationY: 0, pageY: 450 } });
    });
    expect(screen.getByTestId('rail-bubble-chapter')).toHaveTextContent('Check');
    expect(screen.getByTestId('rail-bubble-step')).toHaveTextContent('3 · echo two');
    await act(async () => {
      fireEvent(rail, 'responderRelease', { nativeEvent: { locationY: 0, pageY: 450 } });
    });
    // Gone there: no bubble, and no sheet (a drag is not a tap).
    expect(screen.queryByTestId('rail-bubble')).toBeNull();
    expect(screen.queryByTestId('steps-sheet')).toBeNull();
  });
});

describe('a wide screen', () => {
  it('shows the steps as a side panel instead of the rail', async () => {
    mockWidth = 1280;
    const rb = addRunbook('wide.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-panel')).toBeTruthy();
    expect(screen.queryByTestId('progress-rail')).toBeNull();
    expect(screen.getByTestId('steps-row-1')).toHaveProp('accessibilityLabel', 'Step 1: Say hello, to do, est. 2m');
    // The headline doesn't open a sheet there: the list is in view.
    expect(screen.queryByTestId('run-steps')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-row-3'));
    });
    expect(screen.queryByTestId('steps-sheet')).toBeNull();
  });

  it('a phone shows the rail, and no panel', async () => {
    const rb = addRunbook('narrow.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('progress-rail')).toBeTruthy();
    expect(screen.queryByTestId('steps-panel')).toBeNull();
  });
});

describe('Run all at a step done by hand', () => {
  // Cells: 0 "# Deploy", 1 a block, 2 a checklist item, 3 a block.
  const DEPLOY = ['# Deploy', '', fence('bash', 'echo one'), '- [ ] Tell the team', '', fence('bash', 'echo two')].join('\n');
  const run = async (id: string): Promise<void> => {
    await render(<RunbookView id={id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
  };

  it('waits under the item; Done ticks it and goes on', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    expect(screen.getByTestId('manual-title')).toHaveTextContent('Done by hand?');
    expect(screen.getByTestId('manual-what')).toHaveTextContent('Tell the team');
    expect(sources()).toEqual(['echo one']);
    // The run bar says the run waits for you, and Answer goes there.
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Waiting for you: answer under the cell');
    expect(screen.getByTestId('run-primary')).toHaveTextContent('↓ Answer');
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-progress'));
    });
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', 'Step 2: Tell the team, waiting for you, by hand');
    await act(async () => {
      fireEvent.press(screen.getByTestId('steps-close'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('manual-done'));
    });
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(getRunbook(rb.id)!.text).toContain('- [x] Tell the team');
    await waitFor(() => expect(screen.getByTestId('run-progress')).toHaveTextContent('Done · 3 of 3'));
  });

  it('Skip goes on without ticking it', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-skip.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('manual-skip'));
    });
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    await waitFor(() => expect(screen.getByTestId('run-progress')).toHaveTextContent('2 of 3 steps done'));
    expect(getRunbook(rb.id)!.text).toContain('- [ ] Tell the team');
    expect(screen.queryByTestId('manual-card')).toBeNull();
  });

  it('Stop ends the run there; Resume asks again', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-stop.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('manual-stop'));
    });
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Run all stopped at a step done by hand: Resume asks again.');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sources()).toEqual(['echo one']);
    expect(screen.getByTestId('run-primary')).toHaveTextContent('▶ Resume');
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    expect(sources()).toEqual(['echo one']);
    await act(async () => {
      fireEvent.press(screen.getByTestId('manual-done'));
    });
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
  });

  it('asks at the items after the last block once the run got there', async () => {
    script([{ stdout: 'one\n' }]);
    const rb = addRunbook('close.md', ['# Close', '', fence('bash', 'echo one'), '- [ ] Close the ticket', ''].join('\n'));
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-what')).toHaveTextContent('Close the ticket'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('manual-done'));
    });
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(getRunbook(rb.id)!.text).toContain('- [x] Close the ticket');
  });

  it('does not wait with manual-steps: continue', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const off = addRunbook('continue.md', '---\nmanual-steps: continue\n---\n' + DEPLOY);
    await run(off.id);
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    expect(screen.queryByTestId('manual-card')).toBeNull();
  });

  it('does not wait at a ticked item', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const ticked = addRunbook('ticked.md', DEPLOY.replace('- [ ]', '- [x]'));
    await run(ticked.id);
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    expect(screen.queryByTestId('manual-card')).toBeNull();
  });

  it('does not wait for a single cell’s ▶', async () => {
    script([{ stdout: 'two\n' }]);
    const one = addRunbook('one.md', DEPLOY);
    await render(<RunbookView id={one.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-3-run'));
    });
    await waitFor(() => expect(sources()).toEqual(['echo two']));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByTestId('manual-card')).toBeNull();
  });

  it('items in setup and teardown parts follow the same rule', () => {
    const text = [
      '# Lab',
      '',
      fence('bash setup', 'up'),
      '- [ ] Check the lab answers',
      '',
      fence('bash', 'work'),
      '- [x] Tell the team',
      '- [ ] Note the time',
      '',
      fence('bash teardown', 'down'),
    ].join('\n');
    const cells = parse(text).cells;
    expect(uncheckedBefore(cells, 3, new Set())).toEqual({ cellIndex: 2, item: 0, text: 'Check the lab answers' });
    expect(uncheckedBefore(cells, 5, new Set())).toEqual({ cellIndex: 4, item: 1, text: 'Note the time' });
    expect(uncheckedBefore(cells, 5, new Set(['4:1']))).toBeUndefined();
    const ticked = withItemTicked(text, cells, 4, 1)!;
    expect(ticked).toContain('- [x] Note the time');
    expect(ticked).toContain('- [ ] Check the lab answers');
    // Ticked already: nothing to write.
    expect(withItemTicked(text, cells, 4, 0)).toBeUndefined();
  });
});

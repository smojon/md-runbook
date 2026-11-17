/**
 * The steps by name (as VS Code's Runbook Steps view): on a phone, the Runbook | Steps switch at
 * the top (remembered per runbook), the rail's tap and the run bar's headline switching to Steps;
 * the side panel on a wide screen; the rows (state, time, needs, the failed step's error, a tick
 * box, a long press for the step's actions), Retry step and Resume after a failure, the waiting
 * row's answers; and Run all waiting at a step done by hand (an unticked checklist item).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings, setOutputSetting } from '../settings/store';
import { errorLine, preflightLine, preflightParts, stepsRows, uncheckedBefore, withItemSet, withItemTicked } from '../runbooks/steps';
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
const press = async (testID: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
};

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

describe('a phone: Runbook | Steps', () => {
  it('shows the runbook first; the run bar’s headline switches to Steps, a row back to the runbook', async () => {
    script([{ stdout: 'one\n' }, { stderr: 'boom\n', exitCode: 1 }]);
    const rb = addRunbook('guide.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('view-switch')).toBeTruthy();
    expect(screen.getByTestId('view-runbook')).toBeSelected();
    expect(screen.getByTestId('view-steps')).not.toBeSelected();
    expect(screen.queryByTestId('steps-view')).toBeNull();
    // The runbook keeps its thin rail.
    expect(screen.getByTestId('progress-rail')).toBeTruthy();
    await press('run-progress');
    expect(screen.getByTestId('steps-view')).toBeTruthy();
    expect(screen.getByTestId('view-steps')).toBeSelected();
    // The header says what the run bar says; a phone's Steps has Run all too.
    expect(screen.getByTestId('steps-headline')).toHaveTextContent('1 of 3 steps done');
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^at least 2 min left/);
    expect(screen.getByTestId('steps-run')).toHaveTextContent('▶ Resume');
    // "Guide" has one step: one row, the heading with the step's name under it. "Check" has two.
    expect(screen.queryByTestId('steps-chapter-0')).toBeNull();
    expect(screen.getByTestId('steps-chapter-2')).toHaveTextContent('Check');
    expect(screen.getByTestId('steps-row-1')).toHaveProp('accessibilityLabel', 'Step 1: Guide (Say hello), to do, est. 2m');
    expect(screen.getByTestId('steps-detail-1')).toHaveTextContent('Say hello');
    expect(screen.getByTestId('steps-state-1')).toHaveTextContent('○');
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', 'Step 2: Look at the dashboard, done, by hand');
    expect(screen.getByTestId('steps-state-2')).toHaveTextContent('✓');
    expect(screen.getByTestId('steps-row-3')).toHaveProp('accessibilityLabel', 'Step 3: Check, to do');
    // A tap on a row: the runbook, at that step.
    await press('steps-row-3');
    expect(screen.queryByTestId('steps-view')).toBeNull();
    expect(screen.getByTestId('view-runbook')).toBeSelected();

    await press('run-primary');
    await waitFor(() => expect(screen.getByTestId('run-progress')).toHaveTextContent('Step 3/3 failed'));
    // Not switched by the run: still the runbook.
    expect(screen.queryByTestId('steps-view')).toBeNull();
    // ⋯ More → Show Steps switches too.
    await press('more-actions');
    await press('action-showSteps');
    expect(screen.getByTestId('steps-headline')).toHaveTextContent('Step 3/3 failed');
    expect(screen.getByTestId('steps-row-1')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^Step 1: Guide \(Say hello\), done, took /),
    );
    expect(screen.getByTestId('steps-state-3')).toHaveTextContent('✕');
    // The failed step's last error line, under its row and in what a screen reader says.
    expect(screen.getByTestId('steps-error-3')).toHaveTextContent('boom');
    expect(screen.getByTestId('steps-row-3')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^Step 3: Check, failed.*\. Error: boom$/),
    );
    expect(screen.getByTestId('steps-retry')).toHaveTextContent('Retry step');
    expect(screen.getByTestId('steps-resume')).toHaveTextContent('Resume');
  });

  it('is remembered per runbook', async () => {
    const rb = addRunbook('kept.md', GUIDE);
    const other = addRunbook('other.md', GUIDE);
    const first = await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    expect(screen.getByTestId('steps-view')).toBeTruthy();
    await first.unmount();
    const again = await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-view')).toBeTruthy();
    expect(screen.getByTestId('view-steps')).toBeSelected();
    await again.unmount();
    await render(<RunbookView id={other.id} />);
    expect(screen.queryByTestId('steps-view')).toBeNull();
    expect(screen.getByTestId('view-runbook')).toBeSelected();
  });

  it('a runbook without steps has no switch', async () => {
    const rb = addRunbook('notes.md', '# Notes\n\nJust text.\n');
    await render(<RunbookView id={rb.id} />);
    expect(screen.queryByTestId('view-switch')).toBeNull();
  });

  it('a running step shows ▶ and its time against the estimate; one waiting for you shows the pause icon', async () => {
    const rb = addRunbook('rows.md', GUIDE);
    const cells = parse(getRunbook(rb.id)!.text).cells;
    const progress = textProgress(getRunbook(rb.id)!.text);
    const now = 1_000_000;
    const rows = stepsRows({ cells, progress, running: { cellIndex: 1, startedAt: now - 12_000 }, now });
    expect(rows.find((r) => r.key === '1')).toMatchObject({ state: 'running', time: '12s of 2m', fraction: 0.1 });
    const waiting = stepsRows({ cells, progress, waiting: { cellIndex: 3 }, now });
    expect(waiting.find((r) => r.key === '3')).toMatchObject({ state: 'waiting' });
  });

  it('a chapter with exactly one numbered step is that step’s row; with none, two, or only the ready check, its own', () => {
    const rowsOf = (text: string) =>
      stepsRows({ cells: parse(text).cells, progress: textProgress(text), now: 0 }).map((r) =>
        r.kind === 'chapter' ? `chapter ${r.title}` : `${r.step ?? '·'} ${r.label}${r.detail ? ` / ${r.detail}` : ''} l${r.chapter ?? '-'}`,
      );
    const text = [
      '# Runbook',
      '',
      '## Build',
      '',
      fence('bash name="Compile"', 'make'),
      '## Check',
      '',
      fence('bash', 'make test'),
      '## Ship',
      '',
      fence('bash name="Tag"', 'git tag'),
      fence('bash name="Push"', 'git push'),
      '## Tell the team',
      '',
      '- [ ] Post in the channel',
      '',
    ].join('\n');
    expect(rowsOf(text)).toEqual([
      // No step of its own: its row stays.
      'chapter Runbook',
      // The step's own name under the heading; none when the heading names it.
      '1 Build / Compile l2',
      '2 Check l2',
      'chapter Ship',
      '3 Tag l-',
      '4 Push l-',
      '5 Tell the team / Post in the channel l2',
    ]);
    const lab = ['# Lab', '', fence('bash ready name="the lab"', 'test -f up'), fence('bash teardown name="Stop"', 'rm up')].join('\n');
    // Only the ready check and an offered teardown: not steps, the chapter keeps its row.
    expect(rowsOf(lab)[0]).toBe('chapter Lab');
  });

  it('the error line: the last stderr line, else the output’s, without colours, cut short', () => {
    const out = (text: string, stderr?: string) => ({ text, attrs: { exit: '1', ...(stderr ? { stderr } : {}) } }) as never;
    // stderr= is 1-based: line 2.
    expect(errorLine(out('step 1\nfatal: no such host\nexit code 1\n', '2'))).toBe('fatal: no such host');
    expect(errorLine(out('one\n\x1b[31mlast words\x1b[0m\n\n'))).toBe('last words');
    expect(errorLine(out('x'.repeat(200)))).toHaveLength(120);
    expect(errorLine(undefined)).toBeUndefined();
  });
});

describe('preflight', () => {
  it('each step says what it will need, and the header sums it up before a run', async () => {
    mockWidth = 1280;
    const text = [
      '# Deploy',
      '',
      fence('bash name="Wipe cache" confirm', 'echo wipe'),
      fence('bash name="Push"', 'echo ${secret:PREFLIGHT_TOKEN} ${input:REGION}'),
      '- [ ] Tell the team',
      '',
      fence('bash name="Done"', 'echo done'),
    ].join('\n');
    const rb = addRunbook('preflight.md', text);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-preflight')).toHaveTextContent(
      'Before you run: 1 confirmation · 1 secret to set · 1 value to type · 1 step by hand',
    );
    expect(screen.getByTestId('steps-needs-1')).toHaveTextContent('needs your confirmation');
    expect(screen.getByTestId('steps-needs-2')).toHaveTextContent('needs secret PREFLIGHT_TOKEN (not stored), input REGION');
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', expect.stringMatching(/\. needs secret PREFLIGHT_TOKEN/));
    expect(screen.queryByTestId('steps-needs-4')).toBeNull();
    // Each count is a button: values to type open Set Inputs, with the input not set yet.
    expect(screen.queryByTestId('input-set-REGION')).toBeNull();
    await press('steps-preflight-input');
    expect(screen.getByTestId('input-set-REGION')).toBeTruthy();
  });

  it('a count goes to the first step that needs it (on a phone: the runbook, from Steps)', async () => {
    const rb = addRunbook('pre-phone.md', ['# A', '', fence('bash', 'echo a'), fence('bash confirm', 'echo b')].join('\n'));
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-preflight-confirm');
    expect(screen.queryByTestId('steps-view')).toBeNull();
    expect(screen.getByTestId('view-runbook')).toBeSelected();
  });

  it('in the rows: done steps need nothing; each count knows its first step', () => {
    const text = ['# A', '', fence('bash confirm', 'echo a'), '- [ ] Call', ''].join('\n');
    const cells = parse(text).cells;
    const progress = textProgress(text);
    const rows = stepsRows({ cells, progress, needsOf: () => [{ kind: 'confirm' }], now: 0 });
    expect(rows.find((r) => r.kind === 'step')).toMatchObject({ needs: [{ kind: 'confirm' }] });
    expect(preflightLine(rows)).toBe('Before you run: 1 confirmation · 1 step by hand');
    expect(preflightParts(rows)).toEqual([
      { kind: 'confirm', text: '1 confirmation', index: 1 },
      { kind: 'byHand', text: '1 step by hand', index: 2 },
    ]);
    const running = stepsRows({ cells, progress, needsOf: () => [{ kind: 'confirm' }], running: { cellIndex: 1, startedAt: 0 }, now: 0 });
    expect(running.find((r) => r.kind === 'step')).not.toHaveProperty('needs');
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

describe('the rail', () => {
  it('a tap switches to Steps; press and drag shows the chapter and step at the finger; letting go goes there', async () => {
    const rb = addRunbook('scrub.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    const rail = screen.getByTestId('progress-rail');
    expect(rail).toHaveProp('accessibilityHint', 'Shows the steps. Drag along the rail to go to a step.');
    // 4 cells over 400 px: their marks at 50, 150, 250 and 350.
    await act(async () => {
      fireEvent(rail, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 44, height: 400 } } });
    });
    // A plain tap: the Steps tab (no sheet).
    await act(async () => {
      fireEvent(rail, 'responderGrant', { nativeEvent: { locationY: 40, pageY: 140 } });
      fireEvent(rail, 'responderRelease', { nativeEvent: { locationY: 40, pageY: 140 } });
    });
    expect(screen.getByTestId('steps-view')).toBeTruthy();
    expect(screen.getByTestId('view-steps')).toBeSelected();
    await press('view-runbook');
    expect(screen.queryByTestId('steps-view')).toBeNull();
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
    expect(screen.getByTestId('rail-bubble-step')).toHaveTextContent('3 · Check');
    await act(async () => {
      fireEvent(rail, 'responderRelease', { nativeEvent: { locationY: 0, pageY: 450 } });
    });
    // Gone there: no bubble, and still the runbook (a drag is not a tap).
    expect(screen.queryByTestId('rail-bubble')).toBeNull();
    expect(screen.queryByTestId('steps-view')).toBeNull();
  });
});

describe('a wide screen', () => {
  it('shows the steps as a side panel instead of the rail, and no switch', async () => {
    mockWidth = 1280;
    const rb = addRunbook('wide.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-panel')).toBeTruthy();
    expect(screen.queryByTestId('progress-rail')).toBeNull();
    expect(screen.queryByTestId('view-switch')).toBeNull();
    expect(screen.getByTestId('steps-row-1')).toHaveProp('accessibilityLabel', 'Step 1: Guide (Say hello), to do, est. 2m');
    // The headline doesn't switch there: the list is in view; the run bar beside it has Run all.
    expect(screen.queryByTestId('run-steps')).toBeNull();
    expect(screen.queryByTestId('steps-run')).toBeNull();
    await press('steps-row-3');
    expect(screen.getByTestId('steps-panel')).toBeTruthy();
  });

  it('a phone shows the rail, and no panel', async () => {
    const rb = addRunbook('narrow.md', GUIDE);
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('progress-rail')).toBeTruthy();
    expect(screen.queryByTestId('steps-panel')).toBeNull();
  });

  it('a long press on a row opens the step’s actions, Run Until Here among them', async () => {
    mockWidth = 1280;
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook(
      'until.md',
      ['# U', '', fence('bash', 'echo one'), fence('bash', 'echo two'), fence('bash', 'echo three')].join('\n'),
    );
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityHint', 'Shows the step in the runbook. Long press for its actions.');
    await act(async () => {
      fireEvent(screen.getByTestId('steps-row-2'), 'longPress');
    });
    expect(screen.getByTestId('action-runCell')).toBeTruthy();
    expect(screen.getByTestId('action-markDone')).toBeTruthy();
    await press('action-runUntilHere');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sources()).toEqual(['echo one', 'echo two']);
  });

  it('a checklist row has a tick box', async () => {
    mockWidth = 1280;
    const rb = addRunbook('tick.md', ['# T', '', fence('bash', 'echo one'), '- [ ] Call the team', '- [x] Open the ticket', ''].join('\n'));
    await render(<RunbookView id={rb.id} />);
    expect(screen.getByTestId('steps-tick-2-1')).toHaveProp('accessibilityState', { checked: false });
    expect(screen.getByTestId('steps-tick-2-2')).toHaveProp('accessibilityState', { checked: true });
    await press('steps-tick-2-1');
    expect(getRunbook(rb.id)!.text).toContain('- [x] Call the team');
    await press('steps-tick-2-2');
    expect(getRunbook(rb.id)!.text).toContain('- [ ] Open the ticket');
    const cells = parse(getRunbook(rb.id)!.text).cells;
    expect(withItemSet(getRunbook(rb.id)!.text, cells, 2, 0, true)).toBeUndefined();
  });
});

describe('after a failure: Retry step and Resume', () => {
  const THREE = ['# R', '', fence('bash', 'echo one'), fence('bash', 'echo two'), fence('bash', 'echo three')].join('\n');

  it('Retry step runs the failed step again; Resume runs it and the steps still to do', async () => {
    script([
      { stdout: 'one\n' },
      { stderr: 'boom\n', exitCode: 1 },
      { stderr: 'boom again\n', exitCode: 1 },
      { stdout: 'two\n' },
      { stdout: 'three\n' },
    ]);
    const rb = addRunbook('retry.md', THREE);
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    expect(screen.queryByTestId('steps-retry')).toBeNull();
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-headline')).toHaveTextContent('Step 2/3 failed'));
    expect(sources()).toEqual(['echo one', 'echo two']);
    expect(screen.getByTestId('steps-error-2')).toHaveTextContent('boom');
    await press('steps-retry');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two', 'echo two']));
    await waitFor(() => expect(screen.getByTestId('steps-error-2')).toHaveTextContent('boom again'));
    // Only that step: nothing after it ran.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sources()).toHaveLength(3);
    await press('steps-resume');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two', 'echo two', 'echo two', 'echo three']));
    await waitFor(() => expect(screen.getByTestId('steps-headline')).toHaveTextContent('Done · 3 of 3'));
    expect(screen.queryByTestId('steps-retry')).toBeNull();
    // Still the Steps tab: the run never switches it.
    expect(screen.getByTestId('steps-view')).toBeTruthy();
  });

  it('a phone’s Steps has Stop while it runs', async () => {
    script([{ waitForAbort: true }]);
    const rb = addRunbook('stop.md', THREE);
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-stop')).toHaveTextContent('■ Stop'));
    await press('steps-stop');
    // A step stopped is a step that failed (exit=cancelled): Retry step and Resume.
    await waitFor(() => expect(screen.getByTestId('steps-retry')).toBeTruthy());
    expect(screen.queryByTestId('steps-stop')).toBeNull();
    expect(sources()).toEqual(['echo one']);
  });
});

describe('Run all at a step done by hand', () => {
  // Cells: 0 "# Deploy", 1 a block, 2 a checklist item, 3 a block.
  const DEPLOY = ['# Deploy', '', fence('bash', 'echo one'), '- [ ] Tell the team', '', fence('bash', 'echo two')].join('\n');
  const run = async (id: string): Promise<void> => {
    await render(<RunbookView id={id} />);
    await press('run-primary');
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
    // The switch's Steps has a dot (and says so).
    expect(screen.getByTestId('view-steps-dot')).toBeTruthy();
    expect(screen.getByTestId('view-steps')).toHaveProp('accessibilityLabel', 'Steps, waiting for you');
    await press('manual-done');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(screen.queryByTestId('view-steps-dot')).toBeNull();
    expect(getRunbook(rb.id)!.text).toContain('- [x] Tell the team');
    await waitFor(() => expect(screen.getByTestId('run-progress')).toHaveTextContent('Done · 3 of 3'));
  });

  it('the waiting row has the card’s answers: Done ticks it and goes on', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-row.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await press('view-steps');
    expect(screen.getByTestId('steps-row-2')).toHaveProp('accessibilityLabel', 'Step 2: Tell the team, waiting for you, by hand');
    expect(screen.getByTestId('steps-question-2')).toHaveTextContent('Done by hand? Tell the team');
    // The header says what the run waits for, not the share and the time.
    expect(screen.getByTestId('steps-headline')).toHaveTextContent(/^Waiting for you$/);
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^Done by hand\? Tell the team$/);
    expect(screen.getByTestId('steps-answer-2-done')).toHaveProp('accessibilityLabel', 'Done: Tell the team');
    expect(screen.getByTestId('steps-answer-2-skip')).toBeTruthy();
    expect(screen.getByTestId('steps-answer-2-stop')).toBeTruthy();
    await press('steps-answer-2-done');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(screen.queryByTestId('steps-answers-2')).toBeNull();
    expect(getRunbook(rb.id)!.text).toContain('- [x] Tell the team');
    await waitFor(() => expect(screen.getByTestId('steps-headline')).toHaveTextContent('Done · 3 of 3'));
  });

  it('the row’s Skip goes on without ticking it', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-skip.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await press('view-steps');
    await press('steps-answer-2-skip');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
    await waitFor(() => expect(screen.getByTestId('steps-headline')).toHaveTextContent('2 of 3 steps done'));
    expect(getRunbook(rb.id)!.text).toContain('- [ ] Tell the team');
    expect(screen.queryByTestId('manual-card')).toBeNull();
  });

  it('the row’s Stop ends the run there, as the card’s; Resume asks again', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-stop.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await press('view-steps');
    await press('steps-answer-2-stop');
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(screen.getByTestId('steps-notice')).toHaveTextContent('Run all stopped at a step done by hand: Resume asks again.');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sources()).toEqual(['echo one']);
    expect(screen.getByTestId('steps-run')).toHaveTextContent('▶ Resume');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-answer-2-done')).toBeTruthy());
    expect(sources()).toEqual(['echo one']);
    // Ticking its box is Done too.
    await press('steps-tick-2');
    await waitFor(() => expect(sources()).toEqual(['echo one', 'echo two']));
  });

  it('the card’s Stop: the same', async () => {
    script([{ stdout: 'one\n' }, { stdout: 'two\n' }]);
    const rb = addRunbook('deploy-card-stop.md', DEPLOY);
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-card')).toBeTruthy());
    await press('manual-stop');
    expect(screen.queryByTestId('manual-card')).toBeNull();
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Run all stopped at a step done by hand: Resume asks again.');
    expect(screen.getByTestId('run-primary')).toHaveTextContent('▶ Resume');
  });

  it('asks at the items after the last block once the run got there', async () => {
    script([{ stdout: 'one\n' }]);
    const rb = addRunbook('close.md', ['# Close', '', fence('bash', 'echo one'), '- [ ] Close the ticket', ''].join('\n'));
    await run(rb.id);
    await waitFor(() => expect(screen.getByTestId('manual-what')).toHaveTextContent('Close the ticket'));
    await press('manual-done');
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
    await press('cell-3-run');
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

describe('the waiting row’s other questions', () => {
  // The questions while Run all runs: without the launch form first (launch.test.tsx has it).
  beforeEach(() => setOutputSetting('launchForm', false));
  afterEach(() => resetSettings());
  it('a confirmation: Run runs it, as the card’s Run', async () => {
    script([{ stdout: 'wiped\n' }]);
    const rb = addRunbook('confirm.md', ['# C', '', fence('bash name="Wipe" confirm', 'echo wipe')].join('\n'));
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-answer-1-run')).toBeTruthy());
    expect(screen.getByTestId('steps-question-1')).toHaveTextContent('Run cell 2? It runs as deploy@web-1.');
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^Confirm Wipe$/);
    expect(sources()).toEqual([]);
    await press('steps-answer-1-run');
    await waitFor(() => expect(sources()).toEqual(['echo wipe']));
  });

  it('a confirmation: Cancel doesn’t run it, as the card’s', async () => {
    script([{ stdout: 'wiped\n' }]);
    const rb = addRunbook('confirm-no.md', ['# C', '', fence('bash confirm', 'echo wipe')].join('\n'));
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-answer-1-cancel')).toBeTruthy());
    await press('steps-answer-1-cancel');
    expect(screen.getByTestId('steps-notice')).toHaveTextContent('Cell 2 was not run: you didn’t confirm it.');
    expect(sources()).toEqual([]);
  });

  it('a value to type: Answer shows the runbook at its card', async () => {
    const rb = addRunbook('needs.md', ['# N', '', fence('bash', 'echo ${input:REGION}')].join('\n'));
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-answer-1-answer')).toBeTruthy());
    expect(screen.getByTestId('steps-question-1')).toHaveTextContent('This cell needs REGION');
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^Values to fill in: REGION$/);
    await press('steps-answer-1-answer');
    expect(screen.queryByTestId('steps-view')).toBeNull();
    expect(screen.getByTestId('needs')).toBeTruthy();
  });

  it('the teardown offered: the header asks it, not "100% · nothing left"', async () => {
    script([{ stdout: 'work\n' }]);
    const text = ['# T', '', fence('bash estimate=1m', 'echo work'), fence('bash teardown name="Stop the lab" estimate=1m', 'rm up')].join(
      '\n',
    );
    const rb = addRunbook('teardown.md', text);
    await render(<RunbookView id={rb.id} />);
    await press('view-steps');
    await press('steps-run');
    await waitFor(() => expect(screen.getByTestId('steps-answer-2-take')).toBeTruthy());
    expect(screen.getByTestId('steps-headline')).toHaveTextContent(/^Waiting for you$/);
    expect(screen.getByTestId('steps-progress')).toHaveTextContent(/^Take it down now\? Stop the lab$/);
  });
});

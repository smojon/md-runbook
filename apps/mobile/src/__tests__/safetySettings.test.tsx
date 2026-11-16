/**
 * The extension's safety settings in the app (settings/safety.ts, screens/RunSettings.tsx): the
 * risky-command patterns, the patterns redacted from output, a cell's timeout when it has none,
 * and whether Run all stops at a failed step. Defaults as VS Code's.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DEFAULT_CONFIRM_PATTERNS } from '@md-runbook/core/confirm';
import { parse } from '@md-runbook/core';
import { Host, addHost, resetHosts } from '../hosts/store';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { ConfirmPatternsSetting, RedactionSection, RunningSection } from '../screens/RunSettings';
import { RunbookView } from '../screens/RunbookView';
import { cellTimeoutSeconds, outputRedactor, patternProblem } from '../settings/safety';
import {
  confirmPatterns,
  outputSettings,
  redactionPatterns,
  resetSettings,
  setConfirmPatterns,
  setOutputSetting,
  setRedactionPatterns,
  setTimeoutSeconds,
  timeoutSeconds,
} from '../settings/store';
import { confirmationOf } from '../ssh/cells';
import { runCell } from '../ssh/runCell';
import { FakeRun, fakeConnection } from '../testing/fakeConnection';

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

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };

beforeEach(() => {
  resetSettings();
  resetHosts();
  resetRunbooks();
});

describe('defaults as VS Code’s', () => {
  it('the built-in risky patterns, no extra redaction, no timeout, stop on failure', () => {
    expect(confirmPatterns()).toEqual(DEFAULT_CONFIRM_PATTERNS);
    expect(redactionPatterns()).toEqual([]);
    expect(timeoutSeconds()).toBe(0);
    expect(outputSettings().stopOnFailure).toBe(true);
  });

  it('a cell’s timeout: its own, else the setting; an assistant’s cell gets 2 min when there is none', () => {
    expect(cellTimeoutSeconds(5, false)).toBe(5);
    expect(cellTimeoutSeconds(undefined, false)).toBe(0);
    expect(cellTimeoutSeconds(undefined, true)).toBe(120);
    expect(cellTimeoutSeconds(0, true)).toBe(120);
    setTimeoutSeconds(300);
    expect(cellTimeoutSeconds(undefined, false)).toBe(300);
    expect(cellTimeoutSeconds(0, false)).toBe(0);
  });
});

describe('risky-command patterns', () => {
  it('decide which cells ask first', () => {
    expect(confirmationOf('kubectl delete pod x', 'bash', false)).toBe('delete');
    expect(confirmationOf('terraform destroy', 'bash', false)).toBeUndefined();
    setConfirmPatterns(['\\bterraform\\s+destroy\\b']);
    expect(confirmationOf('terraform destroy', 'bash', false)).toBe('terraform destroy');
    expect(confirmationOf('kubectl delete pod x', 'bash', false)).toBeUndefined();
    setConfirmPatterns(undefined);
    expect(confirmPatterns()).toEqual(DEFAULT_CONFIRM_PATTERNS);
  });

  it('a pattern is checked before it is added', () => {
    expect(patternProblem('confirm', ' ', [])).toEqual({ kind: 'empty' });
    expect(patternProblem('confirm', 'a', ['a'])).toEqual({ kind: 'duplicate' });
    expect(patternProblem('confirm', '(', [])?.kind).toBe('invalid');
    // As VS Code: JavaScript patterns, look-behind included.
    expect(patternProblem('redaction', '(?<=X-Api-Key: )\\S+', [])).toBeUndefined();
  });

  it('are edited as a list: add (checked), remove, back to the defaults', async () => {
    await render(<ConfirmPatternsSetting />);
    expect(screen.getByTestId('confirm-pattern-0')).toHaveTextContent(DEFAULT_CONFIRM_PATTERNS[0]!);
    expect(screen.queryByTestId('confirm-patterns-reset')).toBeNull();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('confirm-pattern-new'), '(oops');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-pattern-add'));
    });
    expect(screen.getByTestId('confirm-pattern-error')).toHaveTextContent(/^Not a regular expression: /);
    expect(confirmPatterns()).toEqual(DEFAULT_CONFIRM_PATTERNS);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('confirm-pattern-new'), 'terraform destroy');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-pattern-add'));
    });
    expect(screen.queryByTestId('confirm-pattern-error')).toBeNull();
    expect(confirmPatterns().at(-1)).toBe('terraform destroy');
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-pattern-0-remove'));
    });
    expect(confirmPatterns()).not.toContain(DEFAULT_CONFIRM_PATTERNS[0]);
    await act(async () => {
      fireEvent.press(screen.getByTestId('confirm-patterns-reset'));
    });
    expect(confirmPatterns()).toEqual(DEFAULT_CONFIRM_PATTERNS);
  });
});

describe('redaction patterns', () => {
  it('are added to the built-in ones, in the file and the reports’ redactor', async () => {
    await render(<RedactionSection />);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('redaction-pattern-new'), 'corp-\\d+');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('redaction-pattern-add'));
    });
    expect(redactionPatterns()).toEqual(['corp-\\d+']);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef';
    expect(outputRedactor().redact(`id corp-123 ${jwt}`)).toBe('id [REDACTED] [REDACTED]');
    const conn = fakeConnection([{ stdout: 'customer corp-42\n' }]);
    const r = await runCell({ host, text: '# X\n\n```bash\necho hi\n```\n', cellIndex: 1, connection: conn });
    expect(r.kind === 'done' && parse(r.text).cells[1]?.output?.text).toBe('customer [REDACTED]');
    await act(async () => {
      fireEvent.press(screen.getByTestId('redaction-pattern-0-remove'));
    });
    expect(redactionPatterns()).toEqual([]);
  });

  it('the live output is redacted on screen too', async () => {
    setRedactionPatterns(['corp-\\d+']);
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ stdout: 'customer corp-42\n', waitForAbort: true }]);
    const rb = addRunbook('x.md', '# X\n\n```bash\nsleep 100\n```\n');
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-live')).toHaveTextContent(/customer \[REDACTED\]/));
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
  });
});

describe('running cells', () => {
  it('a cell without timeout= gets the setting’s', async () => {
    const conn = fakeConnection([{ stdout: 'x\n' }]);
    const text = '# X\n\n```bash\necho a\n```\n\n```bash timeout=5\necho b\n```\n';
    await runCell({ host, text, cellIndex: 1, connection: conn });
    setTimeoutSeconds(600);
    await runCell({ host, text, cellIndex: 1, connection: conn });
    await runCell({ host, text, cellIndex: 2, connection: conn });
    expect(conn.calls.map((c) => c.opts.timeoutMs)).toEqual([0, 600_000, 5000]);
  });

  it('the chips set the timeout; the toggle the stop at a failed step', async () => {
    await render(<RunningSection />);
    expect(screen.getByTestId('timeout-0').props.accessibilityState).toEqual({ selected: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('timeout-300'));
    });
    expect(timeoutSeconds()).toBe(300);
    expect(screen.getByTestId('timeout-300')).toHaveTextContent('5 min');
    await act(async () => {
      fireEvent(screen.getByTestId('setting-stopOnFailure'), 'valueChange', false);
    });
    expect(outputSettings().stopOnFailure).toBe(false);
  });

  const TWO = '# X\n\n```bash\nfalse\n```\n\n```bash\necho after\n```\n';
  const runAll = async (script: FakeRun[]): Promise<string[]> => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection(script);
    const rb = addRunbook('x.md', TWO);
    await render(<RunbookView id={rb.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    return mockConnection.calls.map((c) => c.source);
  };

  it('Run all stops at a failed step by default', async () => {
    setOutputSetting('launchForm', false);
    expect(await runAll([{ exitCode: 1 }, { stdout: 'after\n' }])).toEqual(['false']);
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Run all stopped at a failed step: fix it, then Resume.');
  });

  it('off: Run all goes on after a failed step', async () => {
    setOutputSetting('launchForm', false);
    setOutputSetting('stopOnFailure', false);
    await runAll([{ exitCode: 1 }, { stdout: 'after\n' }]);
    await waitFor(() => expect(screen.getByTestId('cell-2-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['false', 'echo after']);
  });
});

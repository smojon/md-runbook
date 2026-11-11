/**
 * Runbook calls in the app (runbooks/calls.ts): the runbook called comes from the web address next
 * to the caller (D) or from a file picked once (A); it runs as a copy with the parameters passed,
 * and its result comes back to the call's cell. Run all goes on in the copy at a call.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { router } from 'expo-router';
import { addHost, resetHosts } from '../hosts/store';
import { paramValues, resetParamValues } from '../runbooks/params';
import { addRunbook, getRunbook, linkKey, resetRunbooks } from '../runbooks/store';
import { activeCall, calledAddress, resetCalls } from '../runbooks/calls';
import { RunbookView } from '../screens/RunbookView';
import { FakeRun, fakeConnection } from '../testing/fakeConnection';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
jest.mock('../runbooks/files', () => ({
  ...jest.requireActual('../runbooks/files'),
  pickRunbookFile: jest.fn(),
}));
let mockConnection = fakeConnection();
jest.mock('../ssh/connections', () => ({
  connectionFor: jest.fn(async () => mockConnection),
  disconnect: jest.fn(async () => undefined),
  isConnected: jest.fn(() => false),
}));
const script = (runs: FakeRun[]) => (mockConnection = fakeConnection(runs));
const push = router.push as jest.Mock;
const back = router.back as jest.Mock;
const pick = jest.requireMock<{ pickRunbookFile: jest.Mock }>('../runbooks/files').pickRunbookFile;

const CHILD =
  '---\nparams:\n  - STAGE\n---\n# Release\n\n## Change\n\n```bash\necho "change ${param:STAGE}"\n```\n\n## Verify\n\n```bash\necho verify\n```\n';
const PARENT =
  '---\nparams:\n  - STAGE: dev\n---\n# Upgrade\n\n```bash\necho before\n```\n\n```runbook name="Apply" src="releases/1.md" section=Change\nSTAGE=${param:STAGE}\n```\n\n```bash\necho after\n```\n';
const BASE = 'https://raw.githubusercontent.com/acme/ops/main/runbooks/upgrade.md';

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  resetParamValues();
  resetCalls();
  push.mockClear();
  back.mockClear();
  pick.mockReset();
  script([{ stdout: 'ok\n' }]);
});

describe('runbook calls in the app', () => {
  it('stays on the site and repository it came from', () => {
    expect(calledAddress(BASE, 'releases/1.md')).toBe('https://raw.githubusercontent.com/acme/ops/main/runbooks/releases/1.md');
    expect(calledAddress(BASE, '../other.md')).toBe('https://raw.githubusercontent.com/acme/ops/main/other.md');
    expect(calledAddress(BASE, '../../../../evil/x/main/a.md')).toBeUndefined();
    expect(calledAddress(BASE, 'https://example.net/a.md')).toBeUndefined();
    expect(calledAddress('https://example.net/rb/a.md', '../b.md')).toBe('https://example.net/b.md');
  });

  it('opened from a web address: ▷ gets the runbook next to it, runs its section as a copy, and the result comes back', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const fetched: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, text: async () => CHILD, headers: { get: () => null } };
    }) as unknown as typeof fetch;
    const parent = addRunbook('upgrade.md', PARENT, undefined, linkKey(BASE, PARENT));
    await render(<RunbookView id={parent.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-2-run'));
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetched).toEqual(['https://raw.githubusercontent.com/acme/ops/main/runbooks/releases/1.md']);
    const copyId = (push.mock.calls[0]![0] as { params: { id: string } }).params.id;
    const copy = getRunbook(copyId)!;
    expect(copy.fileName).toMatch(/^1\.\d{8}-\d{6}\.md$/);
    expect(paramValues(copyId)).toEqual({ STAGE: 'dev' });
    expect(activeCall(copyId)).toMatchObject({ parentId: parent.id, cellIndex: 2, runbook: 'releases/1.md', sections: ['Change'] });

    // The copy's screen runs the call's section only, then gives the result back and goes back.
    script([{ stdout: 'change dev\n' }]);
    await render(<RunbookView id={copyId} autorun />);
    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['echo "change ${STAGE}"']);
    const out = parse(getRunbook(parent.id)!.text).cells[2]!.output!;
    expect(out.attrs.exit).toBe('0');
    expect(out.attrs.runbook).toBe('releases/1.md');
    expect(out.attrs.copy).toBe(copy.fileName);
    expect(out.attrs.steps).toBe('1 done');
    expect(out.attrs.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opened from a file: the file is picked once, by its name', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const parent = addRunbook('upgrade.md', PARENT);
    pick.mockResolvedValueOnce({ kind: 'picked', name: 'other.md', text: CHILD });
    await render(<RunbookView id={parent.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-2-run'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('run-notice').props.children).toBe('You picked other.md; this step runs 1.md. Pick that file.'),
    );
    expect(push).not.toHaveBeenCalled();
    pick.mockResolvedValueOnce({ kind: 'picked', name: '1.md', text: CHILD });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-2-run'));
    });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    // Remembered: the next run of the call doesn't ask again.
    resetRunbooks();
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('Run all runs the steps before a call, then goes on in the copy', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => CHILD,
      headers: { get: () => null },
    })) as unknown as typeof fetch;
    script([
      { stdout: 'before\n', exitCode: 0 },
      { stdout: 'after\n', exitCode: 0 },
    ]);
    const parent = addRunbook('upgrade.md', PARENT, undefined, linkKey(BASE, PARENT));
    await render(<RunbookView id={parent.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-primary'));
    });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['echo before']);
  });
});

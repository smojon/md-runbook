/**
 * Security review round 4: nothing that acts on a cell later keeps a bare cell index. A card
 * waiting for an answer, a group run, Run all's queue and a cell's ⋯ sheet hold the cell's
 * identity (runbooks/cellRef.ts) and find it again right before they act; a cell that changed or
 * went is not acted on, and the notice says why.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { addHost, pinHostKey, resetHosts } from '../hosts/store';
import { cellRef, resolveCell, runRules, sameRules } from '../runbooks/cellRef';
import { addRunbook, getRunbook, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { resetSettings } from '../settings/store';
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

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const press = async (id: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};
const sources = (): string[] => mockConnection.calls.map((c) => c.source);

// Cells: 0 "# Fix", 1 a proposal, 2 a cell that asks first, 3 the next step.
const PROPOSAL = fence('bash proposed by=ai', 'echo proposal');
const WITH_PROPOSAL = ['# Fix', '', PROPOSAL, fence('bash confirm', 'rm -rf /srv/cache'), fence('bash', 'systemctl restart api')].join(
  '\n',
);
const WITHOUT_PROPOSAL = WITH_PROPOSAL.replace(PROPOSAL + '\n', '');

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  resetSettings();
  mockConnection = fakeConnection([{ stdout: 'ok\n' }]);
});

describe('cellRef', () => {
  it('finds a cell again after cells above it changed, never another one', () => {
    const ref = cellRef(WITH_PROPOSAL, 2)!;
    expect(resolveCell(WITH_PROPOSAL, ref)).toBe(2);
    expect(resolveCell(WITHOUT_PROPOSAL, ref)).toBe(1);
    // Changed code, or other fence options (another host=): not that cell any more.
    expect(resolveCell(WITH_PROPOSAL.replace('rm -rf /srv/cache', 'rm -rf /'), ref)).toBeUndefined();
    expect(resolveCell(WITH_PROPOSAL.replace('bash confirm', 'bash confirm host=prod'), ref)).toBeUndefined();
  });

  it('a copy of the cell added elsewhere: no longer told apart, so not found', () => {
    const one = '# T\n\n' + fence('bash', 'kubectl delete pod x');
    const ref = cellRef(one, 1)!;
    expect(resolveCell(fence('bash', 'kubectl delete pod x') + '\n' + one, ref)).toBeUndefined();
  });

  it('outputs and ticked boxes are no part of the identity', () => {
    const text = '# T\n\n- [ ] drain the node\n\n' + fence('bash', 'uptime');
    const ref = cellRef(text, 0)!;
    expect(resolveCell(text.replace('- [ ]', '- [x]'), ref)).toBe(0);
  });

  it('the front matter is the run’s rules', () => {
    const a = '---\npractice: train\n---\n\n# T\n';
    expect(sameRules(a, { rules: runRules(a) })).toBe(true);
    expect(sameRules(a.replace('train', 'prod-1'), { rules: runRules(a) })).toBe(false);
  });
});

describe('a confirmation waits for its own cell (finding 1)', () => {
  it('a proposal above it rejected meanwhile: Run runs the confirmed cell, not the one now at its place', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('fix.md', WITH_PROPOSAL);
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-run');
    expect(screen.getByTestId('confirm-card')).toBeTruthy();
    // Rejected elsewhere (another device, the editor): every cell below moves up by one.
    await act(async () => updateRunbookText(rb.id, WITHOUT_PROPOSAL));
    await press('confirm-run');
    await waitFor(() => expect(sources()).toEqual(['rm -rf /srv/cache']));
    // Its output on it, where it is now; the next step untouched.
    const cells = parse(getRunbook(rb.id)!.text).cells;
    expect(cells[1]?.output).toBeDefined();
    expect(cells[2]?.output).toBeUndefined();
  });

  it('the cell itself changed meanwhile: its card goes, and nothing runs', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('fix.md', WITH_PROPOSAL);
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-run');
    await act(async () => updateRunbookText(rb.id, WITH_PROPOSAL.replace('rm -rf /srv/cache', 'rm -rf /')));
    expect(screen.queryByTestId('confirm-card')).toBeNull();
    expect(screen.getByTestId('run-notice')).toHaveTextContent('The step a question was about changed or went: nothing ran.');
    expect(sources()).toEqual([]);
  });
});

describe('a group run keeps to the cell confirmed (finding 1)', () => {
  it('cells move during the round: every host runs that cell, its output lands on it', async () => {
    const a = addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'ops', group: 'acme' });
    const b = addHost({ name: 'web-2', hostname: 'web2', port: 22, username: 'ops', group: 'acme' });
    pinHostKey(a.id, 'ecdsa-sha2-nistp256 AAAA1=');
    pinHostKey(b.id, 'ecdsa-sha2-nistp256 AAAA2=');
    const rb = addRunbook('fix.md', WITH_PROPOSAL);
    // The proposal goes while the first host runs.
    const run = mockConnection.session.run.bind(mockConnection.session);
    mockConnection.session.run = async (...args) => {
      const r = await run(...args);
      if (mockConnection.calls.length === 1) updateRunbookText(rb.id, WITHOUT_PROPOSAL);
      return r;
    };
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-actions');
    await press('action-runOnGroup');
    await press('group-acme');
    await press('confirm-run');
    await waitFor(() => expect(parse(getRunbook(rb.id)!.text).cells[1]?.output).toBeDefined());
    expect(sources()).toEqual(['rm -rf /srv/cache', 'rm -rf /srv/cache']);
    expect(parse(getRunbook(rb.id)!.text).cells[1]!.output!.attrs).toMatchObject({ group: 'acme', hosts: 'web-1,web-2' });
    expect(parse(getRunbook(rb.id)!.text).cells[2]?.output).toBeUndefined();
  });
});

describe('a stale ⋯ sheet acts on its cell or not at all (finding 1)', () => {
  it('Run Cell from a sheet opened before the cells moved runs the cell it was opened on', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const text = ['# T', '', PROPOSAL, fence('bash', 'echo mine'), fence('bash', 'echo other')].join('\n');
    const rb = addRunbook('t.md', text);
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-actions');
    await act(async () => updateRunbookText(rb.id, text.replace(PROPOSAL + '\n', '')));
    await press('action-runCell');
    await waitFor(() => expect(sources()).toEqual(['echo mine']));
  });
});

describe('the front matter is part of what a run was asked under (finding 5)', () => {
  const DEPLOY = ['# Deploy', '', fence('bash', 'make image'), fence('bash', 'make push'), fence('bash', 'make check')].join('\n');

  it('Run all paused, then the front matter changed (an editor’s save): the run stops, nothing more runs', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ stdout: '1\n' }, { stdout: '2\n' }, { stdout: '3\n' }]);
    const rb = addRunbook('deploy.md', DEPLOY);
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-actions');
    await press('action-pauseBefore');
    await press('run-primary');
    await waitFor(() => expect(screen.getByTestId('pause-card')).toBeTruthy());
    await act(async () => updateRunbookText(rb.id, '---\nshell: sh\nmanual-steps: continue\n---\n' + DEPLOY));
    expect(screen.queryByTestId('pause-card')).toBeNull();
    expect(screen.getByTestId('run-notice')).toHaveTextContent(/The front matter changed .*: the run stops/);
    expect(sources()).toEqual(['make image']);
  });

  it('a confirmation asked under one front matter is not run under another', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('fix.md', WITH_PROPOSAL);
    await render(<RunbookView id={rb.id} />);
    await press('cell-2-run');
    expect(screen.getByTestId('confirm-card')).toBeTruthy();
    await act(async () => updateRunbookText(rb.id, '---\nmode: isolated\n---\n' + WITH_PROPOSAL));
    expect(screen.queryByTestId('confirm-card')).toBeNull();
    expect(sources()).toEqual([]);
  });
});

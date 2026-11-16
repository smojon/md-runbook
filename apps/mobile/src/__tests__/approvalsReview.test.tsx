/**
 * Security review round 4, finding 2: Approve and Reject act on the proposal reviewed and nothing
 * else. approveCell / rejectCell take the code and fence options the card showed and refuse a
 * cell that isn't that proposal (changed, another cell at its place, or not a proposal at all);
 * a stale ⋯ sheet's Reject never deletes a step of yours.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { approveCell, rejectCell, resetApprovals } from '../approvals/store';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, getRunbook, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { resetSettings } from '../settings/store';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const press = async (id: string): Promise<void> => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};
const PROPOSAL = { info: 'bash proposed by=ai', value: 'kubectl get pods' };
const TEXT = ['# P', '', fence(PROPOSAL.info, PROPOSAL.value), fence('bash', 'make deploy')].join('\n');

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  resetSettings();
  resetApprovals();
});

describe('approveCell / rejectCell take what was reviewed', () => {
  it('approve: the proposal reviewed only', () => {
    expect(approveCell('rb', TEXT, 1, 'app', '2026-11-16T10:00:00', PROPOSAL)).toMatch(/approved-by=app/);
    // Its code changed since it was reviewed.
    expect(approveCell('rb', TEXT.replace('kubectl get pods', 'kubectl delete ns prod'), 1, 'app', 'x', PROPOSAL)).toBeUndefined();
    // Another cell at its place, or a step that isn't a proposal.
    expect(approveCell('rb', TEXT, 2, 'app', 'x', PROPOSAL)).toBeUndefined();
    expect(approveCell('rb', TEXT, 2, 'app', 'x', { info: 'bash', value: 'make deploy' })).toBeUndefined();
  });

  it('reject: never a step that isn’t the proposal reviewed', () => {
    expect(rejectCell(TEXT, 1, PROPOSAL)).not.toContain('kubectl get pods');
    expect(rejectCell(TEXT, 2, PROPOSAL)).toBeUndefined();
    expect(rejectCell(TEXT, 2, { info: 'bash', value: 'make deploy' })).toBeUndefined();
  });
});

describe('the review card and the ⋯ sheet (security review round 4)', () => {
  it('the proposal’s code changed while its card was open: the card goes, nothing is approved', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('p.md', TEXT);
    await render(<RunbookView id={rb.id} />);
    await press('cell-1-actions');
    await press('action-approveProposal');
    expect(screen.getByTestId('approve-card')).toBeTruthy();
    await act(async () => updateRunbookText(rb.id, TEXT.replace('kubectl get pods', 'kubectl delete ns prod')));
    expect(screen.queryByTestId('approve-card')).toBeNull();
    expect(getRunbook(rb.id)!.text).not.toContain('approved-by');
  });

  it('a stale sheet’s Reject: the proposal went and a step of yours took its place, which stays', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const rb = addRunbook('p.md', TEXT);
    await render(<RunbookView id={rb.id} />);
    await press('cell-1-actions');
    // Rejected on another device: make deploy is cell 1 now.
    await act(async () => updateRunbookText(rb.id, TEXT.replace(fence(PROPOSAL.info, PROPOSAL.value) + '\n', '')));
    await press('action-rejectProposal');
    expect(parse(getRunbook(rb.id)!.text).cells.map((c) => c.value.trim())).toContain('make deploy');
    expect(screen.getByTestId('run-notice')).toHaveTextContent(/That step changed or went since: nothing was done/);
  });
});

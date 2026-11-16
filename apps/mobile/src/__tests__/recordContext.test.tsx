/**
 * Record where each step ran (VS Code's mdRunbook.output.recordContext, for a host): the host's
 * Kubernetes context (`context=`) and the account (`on=`) in each output marker, shown as Last
 * run in on the launch form and the Steps header.
 */
import { render, screen } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import type { Host } from '../hosts/store';
import { launchModel } from '../runbooks/launch';
import { lastRunContext, runContextText } from '../runbooks/runContext';
import { resetSettings, setOutputSetting } from '../settings/store';
import { MAX_CONTEXT, contextValue, resetRecordedContexts, runCell } from '../ssh/runCell';
import { fakeConnection } from '../testing/fakeConnection';
import { LaunchSheet } from '../ui/LaunchSheet';
import { StepsHead } from '../ui/StepsView';

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };
const TEXT = '# X\n\n```bash\necho a\n```\n\n```bash kube-context=prod-eu\necho b\n```\n';

beforeEach(() => {
  resetSettings();
  resetRecordedContexts();
});

describe('recording where a step ran', () => {
  it('is off by default, as in VS Code', async () => {
    const conn = fakeConnection([{ stdout: 'a\n' }], 'posix', 'prod-eu');
    const r = await runCell({ host, text: TEXT, cellIndex: 1, connection: conn });
    expect(r.kind === 'done' && r.attrs.context).toBeUndefined();
    expect(conn.contextChecks).toBe(0);
  });

  it('on: the host’s Kubernetes context and the account, asked once per 30 s', async () => {
    setOutputSetting('recordContext', true);
    const conn = fakeConnection([{ stdout: 'a\n' }], 'posix', 'prod-eu');
    const r = await runCell({ host, text: TEXT, cellIndex: 1, connection: conn, runbookId: 'rb' });
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    expect(parse(r.text).cells[1]?.output?.attrs).toMatchObject({ context: 'prod-eu', on: 'deploy@web1' });
    await runCell({ host, text: TEXT, cellIndex: 1, connection: conn, runbookId: 'rb' });
    expect(conn.contextChecks).toBe(1);
  });

  it('a cell’s own kube-context check is the context recorded (no second question)', async () => {
    setOutputSetting('recordContext', true);
    const conn = fakeConnection([{ stdout: 'b\n' }], 'posix', 'prod-eu');
    const r = await runCell({ host, text: TEXT, cellIndex: 2, connection: conn, runbookId: 'rb' });
    expect(r.kind === 'done' && r.attrs.context).toBe('prod-eu');
    expect(conn.contextChecks).toBe(1);
  });

  it('a host without a Kubernetes context records unknown', async () => {
    setOutputSetting('recordContext', true);
    const conn = fakeConnection([{ stdout: 'a\n' }], 'posix');
    const r = await runCell({ host, text: TEXT, cellIndex: 1, connection: conn, runbookId: 'rb' });
    expect(r.kind === 'done' && r.attrs).toMatchObject({ context: 'unknown', on: 'deploy@web1' });
  });

  it('a context that isn’t one short line: one line, no control characters, at most 200 characters (security review round 4)', async () => {
    setOutputSetting('recordContext', true);
    const odd = `prod\u0007-eu\u001b[2m\u2028--> <a href=x>\n${'a'.repeat(300)}`;
    const conn = fakeConnection([{ stdout: 'a\n' }], 'posix', odd);
    const r = await runCell({ host, text: TEXT, cellIndex: 1, connection: conn, runbookId: 'rb' });
    expect(r.kind === 'done' && r.attrs.context).toBe('prod-eu[2m');
    expect(contextValue('x'.repeat(500))).toHaveLength(MAX_CONTEXT);
    expect(contextValue('\u0085\n  eu-1\u009b \r\nrest')).toBe('eu-1');
  });
});

describe('Last run in', () => {
  const ran = (at: string, attrs: string, cmd = 'echo a'): string =>
    `\`\`\`bash\n${cmd}\n\`\`\`\n<!-- md-runbook:output start exit=0 ran=${at} ${attrs} -->\n\`\`\`text\nok\n\`\`\`\n<!-- md-runbook:output end -->\n`;
  const text = [
    '# X',
    '',
    ran('2026-11-16T10:00:00+01:00', 'context=staging on=deploy@web1'),
    ran('2026-11-16T09:30:00+00:00', 'context=prod-eu on=ops@db1', 'echo b'),
    ran('2026-11-16T09:00:00+00:00', 'kube-context=dev', 'echo c'),
  ].join('\n');

  it('is the newest run’s recorded context, from the file (VS Code’s too)', () => {
    // 09:30 UTC is after 10:00+01:00 (09:00 UTC).
    expect(lastRunContext(text)).toEqual({ context: 'prod-eu', on: 'ops@db1' });
    expect(runContextText({ context: 'prod-eu', on: 'ops@db1' })).toBe('prod-eu · ops@db1');
    expect(lastRunContext('# X\n\n' + ran('2026-11-16T09:00:00+00:00', 'kube-context=dev'))).toEqual({ context: 'dev' });
    expect(lastRunContext('# X\n\n```bash\necho a\n```\n')).toBeUndefined();
  });

  const sources = (t: string, recordContext = false) => ({
    text: t,
    cells: [1],
    rows: [],
    params: {},
    inputs: {},
    secretNames: [],
    confirmation: () => undefined,
    estimateSteps: [],
    recordContext,
  });

  it('is on the launch form; with recording on and nothing recorded, it says when it will be', async () => {
    const m = launchModel(sources(text));
    expect(m.lastContext).toBe('prod-eu · ops@db1');
    const blank = '# X\n\n```bash\necho a\n```\n';
    expect(launchModel(sources(blank)).contextLater).toBeUndefined();
    expect(launchModel(sources(blank, true)).contextLater).toBe(true);
    await render(
      <LaunchSheet
        model={m}
        title="X"
        runsOn="deploy@web-1"
        onStart={jest.fn()}
        onBack={jest.fn()}
        onGo={jest.fn()}
        onSetSecret={jest.fn()}
      />,
    );
    expect(screen.getByText('Last run in: prod-eu · ops@db1')).toBeTruthy();
  });

  it('is in the Steps header', async () => {
    await render(<StepsHead header={{ headline: 'Step 1 of 3', context: 'prod-eu · ops@db1' }} />);
    expect(screen.getByTestId('steps-context')).toHaveTextContent('Last run in: prod-eu · ops@db1');
  });
});

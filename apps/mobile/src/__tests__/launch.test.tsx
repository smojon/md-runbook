/**
 * The launch form before Run all (runbooks/launch.ts, ui/LaunchSheet.tsx), as VS Code's: the
 * parameters with their descriptions and choices, the inputs, the secrets not stored (Set each),
 * the risky steps, the steps by hand, the time and where it runs. Start runs without asking for
 * the values again; a risky step still asks. On when there is something on it; a setting turns
 * it off; ⋯ More → Run All… always opens it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { addHost, resetHosts } from '../hosts/store';
import { LaunchSources, launchModel, startValues } from '../runbooks/launch';
import { paramValues, resetLastInputs, resetParamValues } from '../runbooks/params';
import { stepsRows } from '../runbooks/steps';
import { addRunbook, resetRunbooks } from '../runbooks/store';
import { readSecret, resetSecretNames } from '../secrets/store';
import { resetSettings, setOutputSetting } from '../settings/store';
import { confirmationOf } from '../ssh/cells';
import { RunbookView } from '../screens/RunbookView';
import { fakeConnection } from '../testing/fakeConnection';
import { textProgress } from '@md-runbook/core/textProgress';
import { textEstimateSteps } from '@md-runbook/core/estimate';

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
// Cells: 0 front matter + "# Deploy", 1 a block, 2 a checklist item, 3 a risky block, 4 a teardown.
const DEPLOY = [
  '---',
  'params:',
  '  - TARGET: staging  # Where to deploy. One of: staging, prod.',
  '  - TAG  # The image tag.',
  'kube-context: prod-cluster',
  '---',
  '# Deploy',
  '',
  fence(
    'bash name="Build" estimate=1m',
    'make image TAG=${param:TAG} USER=${input:USER}\ncurl -H "${secret:REGISTRY_TOKEN}" https://registry',
  ),
  '- [ ] Tell the team',
  '',
  fence('bash name="Clean up" estimate=30s', 'rm -rf /tmp/build-${param:TARGET}'),
  fence('bash teardown', 'echo ${input:TEARDOWN_ONLY}'),
].join('\n');

const sourcesOf = (text: string, over: Partial<LaunchSources> = {}): LaunchSources => {
  const cells = parse(text).cells;
  return {
    text,
    cells: cells.map((c, i) => (c.kind === 'code' ? i : -1)).filter((i) => i >= 0),
    rows: stepsRows({ cells, progress: textProgress(text), callEstimates: new Map(), learnedEstimates: new Map(), now: 0 }),
    params: {},
    inputs: {},
    secretNames: [],
    confirmation: (source, info) => confirmationOf(source, info, false),
    estimateSteps: textEstimateSteps(text),
    ...over,
  };
};

describe('launchModel', () => {
  it('what Run all will need and do', () => {
    const m = launchModel(sourcesOf(DEPLOY));
    expect(m.params).toEqual([
      {
        name: 'TARGET',
        description: 'Where to deploy.',
        choices: ['staging', 'prod'],
        default: 'staging',
        value: 'staging',
        from: 'default',
      },
      { name: 'TAG', description: 'The image tag.' },
    ]);
    // Not the teardown's: it may not run.
    expect(m.inputs).toEqual([{ name: 'USER', secret: false }]);
    expect(m.secrets).toEqual([{ name: 'REGISTRY_TOKEN', stored: false }]);
    expect(m.risky).toEqual([
      { index: 3, step: 3, label: 'Clean up', match: 'rm -rf', lines: ['rm -rf /tmp/build-${param:TARGET}'], more: 0 },
    ]);
    expect(m.byHand).toEqual([{ index: 2, step: 2, label: 'Tell the team' }]);
    expect(m.byHandWaits).toBe(true);
    expect(m.kubeContext).toBe('prod-cluster');
    expect(m.time).toBe('about 1m30s');
    expect(m.needed).toBe(true);
  });

  it('a risky setup, ready check or teardown is listed too, Steps row or not (security review round 3)', () => {
    const text = [
      '# Rebuild',
      '',
      fence('bash setup name="Wipe"', 'rm -rf /srv/cache'),
      fence('bash ready', 'test -d /srv/cache'),
      fence('bash name="Build"', 'make'),
      fence('bash teardown name="Drop"', 'kubectl delete ns build'),
    ].join('\n');
    const all = sourcesOf(text);
    expect(launchModel(all).risky.map((r) => [r.index, r.label])).toEqual([
      [1, 'Wipe'],
      [4, 'Drop (teardown, offered)'],
    ]);
    // Without their rows (Steps shows them apart): still there, by their names.
    const rows = all.rows.filter((r) => r.kind !== 'step' || r.index === 3);
    expect(launchModel({ ...all, rows }).risky.map((r) => [r.index, r.label, r.step])).toEqual([
      [1, 'Wipe', undefined],
      [4, 'Drop', undefined],
    ]);
  });

  it('values typed before, a masked input, a stored secret; nothing needed without values or risky steps', () => {
    const m = launchModel(
      sourcesOf(DEPLOY, {
        params: { TARGET: 'prod' },
        inputs: { USER: { value: 'ops', masked: true } },
        secretNames: ['REGISTRY_TOKEN'],
      }),
    );
    expect(m.params[0]).toMatchObject({ value: 'prod', from: 'typed' });
    expect(m.inputs).toEqual([{ name: 'USER', secret: true, set: true }]);
    expect(m.secrets).toEqual([{ name: 'REGISTRY_TOKEN', stored: true }]);
    expect(launchModel(sourcesOf('# Plain\n\n```bash\nuptime\n```\n')).needed).toBe(false);
  });

  it('startValues: a choice must be one of them; a parameter without a default needs a value; empty secret inputs stay unset', () => {
    const m = launchModel(sourcesOf(DEPLOY));
    expect(startValues(m, { params: { TARGET: 'qa', TAG: 'v1' }, inputs: {} })).toEqual({
      error: { field: 'param:TARGET', kind: 'choice', name: 'TARGET' },
    });
    expect(startValues(m, { params: {}, inputs: {} })).toEqual({ error: { field: 'param:TAG', kind: 'missing', name: 'TAG' } });
    expect(startValues(m, { params: { TAG: 'v1' }, inputs: { USER: 'ops' } })).toEqual({
      params: { TARGET: 'staging', TAG: 'v1' },
      inputs: { USER: 'ops' },
    });
  });
});

describe('the launch sheet', () => {
  const press = async (id: string): Promise<void> => {
    await act(async () => {
      fireEvent.press(screen.getByTestId(id));
    });
  };
  const type = async (id: string, text: string): Promise<void> => {
    await act(async () => {
      fireEvent.changeText(screen.getByTestId(id), text);
    });
  };
  beforeEach(() => {
    resetHosts();
    resetRunbooks();
    resetSettings();
    resetParamValues();
    resetLastInputs();
    resetSecretNames();
    mockConnection = fakeConnection();
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
  });

  const RUN = [
    '---',
    'params:',
    '  - TARGET: staging  # Where to deploy. One of: staging, prod.',
    '---',
    '# Deploy',
    '',
    fence('bash name="Build"', 'echo ${param:TARGET} ${input:USER}'),
    fence('bash name="Clean up"', 'rm -rf /tmp/x'),
  ].join('\n');

  it('Run all opens it; Start runs with its values, asks for none of them; the risky step still asks', async () => {
    mockConnection = fakeConnection([{ stdout: 'ok\n' }, { stdout: 'gone\n' }]);
    const rb = addRunbook('run.md', RUN);
    await render(<RunbookView id={rb.id} />);
    await press('run-primary');
    expect(screen.getByTestId('launch-sheet')).toBeTruthy();
    expect(screen.getByTestId('launch-sub')).toHaveTextContent('Deploy · 2 blocks without an estimate');
    expect(screen.getByTestId('launch-param-TARGET-staging')).toHaveProp('accessibilityState', { selected: true });
    expect(screen.getByTestId('launch-risky-2')).toHaveTextContent(/Step 2 · Clean up.*matches “rm -rf”.*rm -rf \/tmp\/x/);
    expect(screen.getByText('Runs on deploy@web-1')).toBeTruthy();
    expect(mockConnection.calls).toHaveLength(0);
    await press('launch-param-TARGET-prod');
    await type('launch-input-USER', 'ops');
    await press('launch-start');
    expect(screen.queryByTestId('launch-sheet')).toBeNull();
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    expect(mockConnection.calls[0]?.opts.env).toMatchObject({ TARGET: 'prod', USER: 'ops' });
    expect(screen.queryByTestId('needs')).toBeNull();
    expect(paramValues(rb.id)).toEqual({ TARGET: 'prod' });
    // The risky step asks when it gets there.
    await waitFor(() => expect(screen.getByTestId('confirm-card')).toBeTruthy());
    await press('confirm-run');
    await waitFor(() => expect(mockConnection.calls).toHaveLength(2));
  });

  it('says what is wrong instead of starting', async () => {
    const rb = addRunbook(
      'tag.md',
      ['---', 'params:', '  - TAG  # The image tag.', '---', '# Tag', '', fence('bash', 'echo ${param:TAG}')].join('\n'),
    );
    await render(<RunbookView id={rb.id} />);
    await press('run-primary');
    await press('launch-start');
    expect(screen.getByTestId('launch-error-param-TAG')).toHaveTextContent('Type a value for TAG: it has no default.');
    expect(mockConnection.calls).toHaveLength(0);
    await press('launch-back');
    expect(screen.queryByTestId('launch-sheet')).toBeNull();
  });

  it('Set stores a secret not stored yet, here', async () => {
    const rb = addRunbook('s.md', '# S\n\n' + fence('bash', 'curl -H "${secret:API_TOKEN}" https://x'));
    await render(<RunbookView id={rb.id} />);
    await press('run-primary');
    expect(screen.getByTestId('launch-secret-API_TOKEN-state')).toHaveTextContent('not stored');
    expect(screen.getByTestId('launch-missing')).toHaveTextContent(/^Secret API_TOKEN is not stored/);
    await type('launch-secret-API_TOKEN-value', 's3cret-token');
    await press('launch-secret-API_TOKEN-set');
    await waitFor(() => expect(screen.getByTestId('launch-secret-API_TOKEN-state')).toHaveTextContent('stored'));
    expect(await readSecret('API_TOKEN')).toBe('s3cret-token');
    expect(screen.queryByTestId('launch-missing')).toBeNull();
  });

  it('nothing on it, or the setting off: Run all runs; ⋯ More → Run All… still opens it', async () => {
    mockConnection = fakeConnection([{ stdout: 'up\n' }, { stdout: 'ok\n' }]);
    const plain = addRunbook('plain.md', '# Plain\n\n' + fence('bash', 'uptime'));
    const first = await render(<RunbookView id={plain.id} />);
    await press('run-primary');
    expect(screen.queryByTestId('launch-sheet')).toBeNull();
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    await first.unmount();

    setOutputSetting('launchForm', false);
    const rb = addRunbook('run.md', RUN);
    await render(<RunbookView id={rb.id} />);
    await press('more-actions');
    await press('action-runAllForm');
    expect(screen.getByTestId('launch-sheet')).toBeTruthy();
    await press('launch-back');
    await press('run-primary');
    expect(screen.queryByTestId('launch-sheet')).toBeNull();
    // Without the form, the value is asked for when the step runs.
    await waitFor(() => expect(screen.getByTestId('needs')).toBeTruthy());
  });
});

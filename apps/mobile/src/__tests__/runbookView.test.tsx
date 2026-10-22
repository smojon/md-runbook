import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parse } from '@md-runbook/core';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { addHost, resetHosts } from '../hosts/store';
import { resetParamValues } from '../runbooks/params';
import { readSecret } from '../secrets/store';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { RunbookView } from '../screens/RunbookView';
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
}));

const script = (runs: FakeRun[]) => (mockConnection = fakeConnection(runs));

beforeEach(() => {
  resetHosts();
  resetRunbooks();
  script([{ stdout: 'ok\n' }]);
});

describe('runbook parameters', () => {
  beforeEach(() => resetParamValues());
  const text = '---\nparams:\n  - REGION: eu-west-1\n---\n\n# Deploy\n\n```bash\necho "${param:TARGET} ${param:REGION}"\n```\n';

  it('are typed on the runbook, the default as placeholder, and reach the cell', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const r = addRunbook('deploy.md', text);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('param-REGION').props.placeholder).toBe('eu-west-1');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('param-TARGET'), 'web-1');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    expect(mockConnection.calls[0]?.opts.env).toMatchObject({ TARGET: 'web-1', REGION: 'eu-west-1' });
  });

  it('a runbook without parameters has no card', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('params')).toBeNull();
  });
});

describe('secrets and inputs', () => {
  it('a cell asks for them, stores the secret, keeps the input, then runs', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const r = addRunbook('api.md', '# API\n\n```bash\ncurl -u "${input:USER}:${secret:API_KEY}" https://api\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('needs')).toBeTruthy());
    expect(mockConnection.calls).toHaveLength(0);
    expect(screen.getByTestId('need-API_KEY').props.secureTextEntry).toBe(true);
    expect(screen.getByTestId('need-USER').props.secureTextEntry).toBe(false);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('need-USER'), 'ops');
      fireEvent.changeText(screen.getByTestId('need-API_KEY'), 'k-123456');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('needs-run'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    expect(mockConnection.calls[0]?.opts.env).toMatchObject({ USER: 'ops', API_KEY: 'k-123456' });
    expect(await readSecret('API_KEY')).toBe('k-123456');
    // Run again: nothing is asked.
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(2));
    expect(screen.queryByTestId('needs')).toBeNull();

    // The Inputs card shows what was typed; Change replaces it, Clear makes the next run ask.
    expect(screen.getByText('USER = ops')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('input-change-USER'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('input-value-USER'), 'dev');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('input-save-USER'));
    });
    await waitFor(() => expect(screen.getByText('USER = dev')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(3));
    expect(mockConnection.calls[2]?.opts.env).toMatchObject({ USER: 'dev' });
    await act(async () => {
      fireEvent.press(screen.getByTestId('input-clear-USER'));
    });
    expect(screen.queryByTestId('inputs')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('needs')).toBeTruthy());
    expect(screen.queryByTestId('need-API_KEY')).toBeNull();
  });

  it('cancelling runs nothing and says so', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const r = addRunbook('who.md', '# Who\n\n```bash\necho ${input:WHO}\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('needs')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('needs-cancel'));
    });
    expect(screen.getByTestId('run-notice').props.children).toBe('Cancelled: WHO not given, nothing was run');
    expect(mockConnection.calls).toHaveLength(0);
  });
});

describe('a signed runbook', () => {
  const plain = '# Restart\n\n```bash\nsystemctl restart api\n```\n';
  const built = buildManifest(plain, { name: 'ops/restart', version: 7, expires: '2027-04-30', scopes: [], patterns: {} });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const signed = withSignature(plain, {
    signer: 'ops@example.net',
    signed: '2026-10-22',
    manifest: formatManifest(built.manifest),
    signature: 'U1NIU0lH',
  });

  it('shows who signed which version, and the blocks changed since', async () => {
    const r = addRunbook('restart.md', signed);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByText('Signed runbook ops/restart, version 7, by ops@example.net')).toBeTruthy();
    expect(screen.getByText(/^Valid until 2027-04-30\./)).toBeTruthy();
    expect(screen.queryByTestId('signed-changed')).toBeNull();
    const changed = addRunbook('changed.md', signed.replace('restart api', 'stop api'));
    await render(<RunbookView id={changed.id} />);
    expect(screen.getByTestId('signed-changed').props.children).toMatch(/^1 block changed since signing/);
  });

  it('an unsigned runbook has no banner', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('signed-banner')).toBeNull();
  });
});

describe('the VS Code-like runbook view', () => {
  it('renders Markdown cells as text, not source', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByText('Check a web server')).toBeTruthy();
    expect(screen.queryByText(/^# Check/)).toBeNull();
    expect(screen.getByText('Service')).toBeTruthy();
    expect(screen.getByText('Log in to the server')).toBeTruthy();
  });

  it('a task box ticks the item in the runbook and back', async () => {
    await render(<RunbookView id="sample" />);
    const box = screen.getByTestId('task-0');
    expect(box.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => {
      fireEvent.press(box);
    });
    expect(getRunbook('sample')?.text).toContain('- [x] Log in to the server');
    expect(screen.getByTestId('task-0').props.accessibilityState).toMatchObject({ checked: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-0'));
    });
    expect(getRunbook('sample')?.text).toContain('- [ ] Log in to the server');
  });

  it('shows the last result of a cell and the language with its options', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId('cell-1-status').props.accessibilityLabel).toBe('Succeeded');
    expect(screen.getByText('bash expect=/active \\(running\\)/')).toBeTruthy();
  });

  it('a tap on a line opens its actions; Run line runs that command only', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: '/dev/sda1 40G\n' }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1'));
    });
    expect(screen.getByTestId('cell-1-line-1-actions')).toBeTruthy();
    expect(screen.getByText('Run line 2')).toBeTruthy();
    expect(screen.getByText('Run lines 1-2')).toBeTruthy();
    // The last command has no "Run lines N-end".
    expect(screen.queryByTestId('cell-1-line-1-run-from')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['df -h /']);
    const out = parse(getRunbook('sample')!.text).cells[1]?.output;
    expect(out?.attrs.lines).toBe('2');
    expect(out?.text).toBe('$ df -h /\n/dev/sda1 40G');
    expect(screen.getByText(/lines 2/)).toBeTruthy();
  });

  it('checked lines get a run button on the status line', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: 'up\n' }]);
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('cell-1-run-checked')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-0'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-0-check'));
    });
    expect(screen.getByText('Run 1 checked line')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run-checked'));
    });
    await waitFor(() => expect(mockConnection.calls).toHaveLength(1));
    expect(mockConnection.calls[0]?.source).toBe('uptime');
    await waitFor(() => expect(parse(getRunbook('sample')!.text).cells[1]?.output?.attrs.lines).toBe('1'));
  });

  it('Step through runs the first command, then waits before each of the others', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: 'up\n' }, { stdout: 'disk\n' }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-paused')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['uptime']);
    expect(screen.getByText('Paused before line 2')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step-next'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['uptime', 'df -h /']);
    const out = parse(getRunbook('sample')!.text).cells[1]?.output;
    expect(out?.attrs.lines).toBeUndefined();
    expect(out?.text).toBe('$ uptime\nup\n$ df -h /\ndisk');
  });

  it('Stop while paused keeps what ran; the output says which lines', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    script([{ stdout: 'up\n' }]);
    await render(<RunbookView id="sample" />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-paused')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls).toHaveLength(1);
    expect(parse(getRunbook('sample')!.text).cells[1]?.output?.attrs).toMatchObject({ exit: '0', lines: '1' });
  });

  it('Continue runs the rest without pausing; Step from here starts at a line', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const text = '# T\n\n```bash\necho a\necho b\necho c\n```\n';
    const r = addRunbook('t.md', text);
    script([{ stdout: 'a\n' }, { stdout: 'b\n' }, { stdout: 'c\n' }]);
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-paused')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['echo a', 'echo b', 'echo c']);

    script([{ stdout: 'b\n' }, { stdout: 'c\n' }]);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-line-1-step-from'));
    });
    await waitFor(() => expect(screen.getByText('Paused before line 3')).toBeTruthy());
    expect(mockConnection.calls.map((c) => c.source)).toEqual(['echo b']);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-step-next'));
    });
    await waitFor(() => expect(parse(getRunbook(r.id)!.text).cells[1]?.output?.attrs.lines).toBe('2-3'));
  });

  it('a host= cell runs on that host, whichever is selected; an unknown name says so', async () => {
    const { connectionFor } = jest.requireMock<{ connectionFor: jest.Mock }>('../ssh/connections');
    connectionFor.mockClear();
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    const db = addHost({ name: 'DB', hostname: 'db1', port: 22, username: 'ops' });
    const r = addRunbook('t.md', '# T\n\n```bash host=db\necho on-db\n```\n\n```bash host=gone\necho x\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-output')).toBeTruthy());
    expect(connectionFor.mock.calls[0]?.[0]).toMatchObject({ id: db.id, hostname: 'db1' });
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-2-run'));
    });
    expect(screen.getByTestId('run-notice').props.children).toMatch(/runs on the host gone .*no host with that name/);
    expect(connectionFor).toHaveBeenCalledTimes(1);
  });

  it('without a host there is no run button and no line actions are open', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.queryByTestId('cell-1-run')).toBeNull();
    expect(screen.queryByTestId('cell-1-line-0-actions')).toBeNull();
  });
});

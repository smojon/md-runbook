import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { addHost, resetHosts } from '../hosts/store';
import { addRunbook, resetRunbooks } from '../runbooks/store';
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

beforeEach(() => {
  resetHosts();
  resetRunbooks();
});

const DONE = '<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';

describe('estimate= (how long a cell takes)', () => {
  it('shows on the cell, and the top says how far the runbook is by the estimates', async () => {
    const r = addRunbook(
      'est.md',
      `# Steps\n\n\`\`\`bash estimate=2m30s\necho one\n\`\`\`\n${DONE}\n\`\`\`bash\necho two\n\`\`\`\n\n\`\`\`bash estimate=3m30s\necho three\n\`\`\`\n`,
    );
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('cell-1-estimate')).toHaveTextContent('est. 2m30s');
    expect(screen.queryByTestId('cell-2-estimate')).toBeNull();
    expect(screen.getByTestId('run-estimate-text')).toHaveProp(
      'accessibilityLabel',
      '41% by the estimates · about 4 min left · 1 block without an estimate',
    );
    // On screen, short: icons and times.
    expect(screen.getByTestId('estimate-done')).toHaveTextContent('41%');
    expect(screen.getByTestId('estimate-left')).toHaveTextContent(/~4m$/);
    expect(screen.getByTestId('estimate-unestimated')).toHaveTextContent(/1$/);
  });

  it('says nothing about estimates in a runbook without any', async () => {
    const r = addRunbook('plain.md', '# Steps\n\n```bash\necho one\n```\n');
    await render(<RunbookView id={r.id} />);
    expect(screen.queryByTestId('run-estimate')).toBeNull();
    expect(screen.queryByTestId('cell-1-estimate')).toBeNull();
  });

  it('a running cell shows a bar against its estimate, and how much over once past it', async () => {
    addHost({ name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' });
    mockConnection = fakeConnection([{ waitForAbort: true }]);
    const r = addRunbook('slow.md', '# Steps\n\n```bash estimate=1\nsleep 100\n```\n');
    await render(<RunbookView id={r.id} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-run'));
    });
    await waitFor(() => expect(screen.getByTestId('cell-1-timing')).toHaveTextContent(/of 1s$/));
    await waitFor(() => expect(screen.getByTestId('cell-1-timing')).toHaveTextContent(/^\+\d+s over 1s$/), { timeout: 5000 });
    expect(screen.getByTestId('run-estimate-text')).toHaveProp('accessibilityLabel', '0% by the estimates · nothing left');
    expect(screen.getByTestId('estimate-left')).toHaveTextContent(/0m$/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('cell-1-stop'));
    });
    await waitFor(() => expect(screen.queryByTestId('cell-1-timing')).toBeNull());
  });
});

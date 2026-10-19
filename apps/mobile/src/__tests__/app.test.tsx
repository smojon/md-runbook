import { render, screen } from '@testing-library/react-native';
import { checkCore } from '../coreCheck';
import { RunbookList } from '../screens/RunbookList';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => {
  const { Fragment } = jest.requireActual('react');
  return { Link: ({ children }: { children: unknown }) => children, Stack: { Screen: () => null }, Fragment };
});

describe('the shared core in the app', () => {
  it('round-trips the sample and runs RE2 checks', () => {
    expect(checkCore()).toEqual({ ok: true });
  });
});

describe('screens', () => {
  it('lists the sample runbook and says the core works', async () => {
    await render(<RunbookList />);
    expect(screen.getByTestId('runbook-sample')).toBeTruthy();
    expect(screen.getByText('2 commands')).toBeTruthy();
    expect(screen.getByTestId('core-status').props.children).toBe('Core OK');
  });

  it('shows the cells of a runbook with their saved output', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByText(/uptime/)).toBeTruthy();
    expect(screen.getByTestId('cell-1-output')).toBeTruthy();
  });

  it('says when a runbook does not exist', async () => {
    await render(<RunbookView id="nope" />);
    expect(screen.getByTestId('runbook-not-found')).toBeTruthy();
  });

  it('copes with a large runbook', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `Step ${i}\n\n\`\`\`bash\necho ${i}\n\`\`\`\n`).join('\n');
    expect(checkCore(big)).toEqual({ ok: true });
  });
});

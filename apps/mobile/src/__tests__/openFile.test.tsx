import { act, render, screen } from '@testing-library/react-native';
import { getDocumentAsync } from 'expo-document-picker';
import { openRunbookFile } from '../runbooks/openFile';
import { MAX_RUNBOOK_BYTES, getRunbook, resetRunbooks, titleOf } from '../runbooks/store';
import { RunbookList } from '../screens/RunbookList';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
const mockFileText = jest.fn<Promise<string>, [string]>();
jest.mock('expo-file-system', () => ({
  File: function MockFile(this: { text: () => Promise<string> }, mockUri: string) {
    this.text = () => mockFileText(mockUri);
  },
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: unknown }) => children, router: { push: jest.fn() } }));

const pick = getDocumentAsync as jest.MockedFunction<typeof getDocumentAsync>;
const asset = (over: object = {}) => ({
  canceled: false as const,
  assets: [{ name: 'deploy.md', uri: 'file:///cache/deploy.md', size: 100, ...over }],
});

beforeEach(() => {
  resetRunbooks();
  pick.mockReset();
  mockFileText.mockReset();
});

describe('opening a runbook file', () => {
  it('reads the picked file (iOS/Android) and titles it from its first heading', async () => {
    pick.mockResolvedValue(asset() as never);
    mockFileText.mockResolvedValue('# Deploy the web app\n\n```bash\necho hi\n```\n');
    const r = await openRunbookFile();
    expect(mockFileText).toHaveBeenCalledWith('file:///cache/deploy.md');
    expect(r.kind).toBe('opened');
    if (r.kind !== 'opened') return;
    expect(r.runbook.title).toBe('Deploy the web app');
    expect(getRunbook(r.runbook.id)?.text).toContain('echo hi');
  });

  it("uses the browser's File on the web", async () => {
    pick.mockResolvedValue(asset({ file: { text: () => Promise.resolve('no heading here') } }) as never);
    const r = await openRunbookFile();
    expect(mockFileText).not.toHaveBeenCalled();
    expect(r.kind === 'opened' && r.runbook.title).toBe('deploy');
  });

  it('canceled, too large and unreadable files open nothing', async () => {
    pick.mockResolvedValue({ canceled: true, assets: null });
    expect(await openRunbookFile()).toEqual({ kind: 'canceled' });

    pick.mockResolvedValue(asset({ size: MAX_RUNBOOK_BYTES + 1 }) as never);
    expect(await openRunbookFile()).toMatchObject({ kind: 'error', message: expect.stringContaining('larger than 2 MB') });

    pick.mockResolvedValue(asset({ size: undefined }) as never);
    mockFileText.mockResolvedValue('x'.repeat(MAX_RUNBOOK_BYTES + 1));
    expect(await openRunbookFile()).toMatchObject({ kind: 'error' });

    mockFileText.mockRejectedValue(new Error('permission denied'));
    expect(await openRunbookFile()).toMatchObject({ kind: 'error', message: expect.stringContaining('permission denied') });
    expect(getRunbook('file-1')).toBeUndefined();
  });

  it('titles fall back to the file name', () => {
    expect(titleOf('text\n## not a title?', 'ops.md')).toBe('ops');
    expect(titleOf('intro\n# Real title #\n', 'ops.md')).toBe('Real title');
  });

  it('the list shows a runbook once it is opened', async () => {
    await render(<RunbookList />);
    expect(screen.queryByText('Deploy')).toBeNull();
    pick.mockResolvedValue(asset() as never);
    mockFileText.mockResolvedValue('# Deploy\n');
    await act(async () => {
      await openRunbookFile();
    });
    expect(screen.getByText('Deploy')).toBeTruthy();
    expect(screen.getByTestId('open-runbook')).toBeTruthy();
  });
});

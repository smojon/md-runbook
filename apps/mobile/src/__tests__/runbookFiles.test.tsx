import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Origin } from '../runbooks/origin';
import { saveRunbook } from '../runbooks/save';
import {
  addRunbook,
  flushRunbooks,
  getRunbook,
  hasUnsavedChanges,
  loadRunbooks,
  removeRunbook,
  resetRunbooks,
  updateRunbookText,
} from '../runbooks/store';
import { RunbookList } from '../screens/RunbookList';
import { RunbookView } from '../screens/RunbookView';

/** The app's own copies, kept across "restarts" (resetRunbooks + loadRunbooks) of this test file. */
const mockDocs = new Map<string, string>();
jest.mock('../storage/docs', () => ({
  readDoc: async (id: string) => mockDocs.get(id),
  writeDoc: async (id: string, text: string) => void mockDocs.set(id, text),
  deleteDoc: async (id: string) => void mockDocs.delete(id),
}));

/** The runbooks' files, by origin uri. */
const mockFiles = new Map<string, string>();
const mockWrites: string[] = [];
jest.mock('../runbooks/files', () => ({
  canDownload: false,
  canSaveInPlace: () => true,
  readOrigin: async (o: { uri: string }) => {
    const text = mockFiles.get(o.uri);
    if (text === undefined) throw new Error('file gone');
    return { text };
  },
  writeOrigin: async (o: { uri: string }, text: string) => {
    mockWrites.push(o.uri);
    mockFiles.set(o.uri, text);
  },
  downloadText: jest.fn(),
  forgetOrigin: jest.fn(async () => undefined),
  pickRunbookFile: jest.fn(),
}));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));

const origin: Origin = { kind: 'uri', uri: 'content://docs/deploy.md' };
const restart = async (): Promise<void> => {
  await flushRunbooks();
  resetRunbooks();
  await loadRunbooks();
};

beforeEach(() => {
  resetRunbooks();
  mockDocs.clear();
  mockFiles.clear();
  mockWrites.length = 0;
});

describe('remembering runbooks', () => {
  it('opened runbooks and their outputs are there after a restart, linked to their file', async () => {
    mockFiles.set(origin.uri, '# Deploy\n');
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    updateRunbookText(r.id, '# Deploy v2\n');
    updateRunbookText('sample', '# Sample, ran\n');
    await restart();
    const again = getRunbook(r.id);
    expect(again).toMatchObject({ title: 'Deploy v2', text: '# Deploy v2\n', fileName: 'deploy.md', origin });
    expect(hasUnsavedChanges(again!)).toBe(true);
    expect(getRunbook('sample')?.text).toBe('# Sample, ran\n');
  });

  it('a removed runbook is gone after a restart; its file is untouched', async () => {
    mockFiles.set(origin.uri, '# Deploy\n');
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    expect(removeRunbook(r.id)?.id).toBe(r.id);
    expect(removeRunbook('sample')).toBeUndefined();
    await restart();
    expect(getRunbook(r.id)).toBeUndefined();
    expect(mockDocs.has(r.id)).toBe(false);
    expect(mockFiles.get(origin.uri)).toBe('# Deploy\n');
  });
});

describe('saving back to the file', () => {
  it('writes the runbook to its file; then nothing is unsaved', async () => {
    mockFiles.set(origin.uri, '# Deploy\n');
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    updateRunbookText(r.id, '# Deploy\n\nran\n');
    expect(await saveRunbook(r.id)).toEqual({ kind: 'saved' });
    expect(mockFiles.get(origin.uri)).toBe('# Deploy\n\nran\n');
    expect(hasUnsavedChanges(getRunbook(r.id)!)).toBe(false);
    expect(await saveRunbook(r.id)).toEqual({ kind: 'unchanged' });
    expect(mockWrites).toHaveLength(1);
  });

  it('does not overwrite a file changed elsewhere unless asked', async () => {
    mockFiles.set(origin.uri, '# Deploy\n');
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    updateRunbookText(r.id, '# Deploy\n\nmine\n');
    mockFiles.set(origin.uri, '# Deploy\n\ntheirs\n');
    expect(await saveRunbook(r.id)).toEqual({ kind: 'conflict', fileText: '# Deploy\n\ntheirs\n' });
    expect(mockWrites).toHaveLength(0);
    expect(await saveRunbook(r.id, { overwrite: true })).toEqual({ kind: 'saved' });
    expect(mockFiles.get(origin.uri)).toBe('# Deploy\n\nmine\n');
  });

  it('a file that is gone is an error, not a crash', async () => {
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    updateRunbookText(r.id, 'x');
    expect(await saveRunbook(r.id)).toMatchObject({ kind: 'error', message: expect.stringMatching(/file gone/) });
  });
});

describe('the save bar and the list', () => {
  it('shows the state, saves, and resolves a conflict by loading the file', async () => {
    mockFiles.set(origin.uri, '# Deploy\n');
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    await render(<RunbookView id={r.id} />);
    expect(screen.getByTestId('save-state').props.children).toBe('Saved');
    await act(async () => updateRunbookText(r.id, '# Deploy\n\nmine\n'));
    expect(screen.getByTestId('save-state').props.children).toBe('Not saved to the file');
    mockFiles.set(origin.uri, '# Deploy\n\ntheirs\n');
    await act(async () => {
      fireEvent.press(screen.getByTestId('save-runbook'));
    });
    await waitFor(() => expect(screen.getByTestId('save-conflict')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('save-load-file'));
    });
    expect(getRunbook(r.id)?.text).toBe('# Deploy\n\ntheirs\n');
    expect(screen.getByTestId('save-state').props.children).toBe('Saved');
    expect(screen.queryByTestId('save-conflict')).toBeNull();
  });

  it('the bundled sample is kept in the app', async () => {
    await render(<RunbookView id="sample" />);
    expect(screen.getByTestId('save-state').props.children).toBe('Kept in the app');
    expect(screen.queryByTestId('save-runbook')).toBeNull();
  });

  it('removing from the list asks first', async () => {
    const r = addRunbook('deploy.md', '# Deploy\n', origin);
    await render(<RunbookList />);
    expect(screen.queryByTestId('remove-sample')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId(`remove-${r.id}`));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId(`remove-${r.id}-cancel`));
    });
    expect(getRunbook(r.id)).toBeDefined();
    await act(async () => {
      fireEvent.press(screen.getByTestId(`remove-${r.id}`));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId(`remove-${r.id}-confirm`));
    });
    expect(getRunbook(r.id)).toBeUndefined();
    expect(screen.queryByTestId(`runbook-${r.id}`)).toBeNull();
  });
});

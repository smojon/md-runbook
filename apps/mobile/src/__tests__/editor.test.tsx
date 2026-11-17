/**
 * Edit as Text, a screen of its own (as VS Code opens a runbook as text, as a preview or as a
 * runbook), and New Runbook… on the start screen. Saving warns before a matching signature breaks;
 * unsaved text survives leaving the screen; outputs are text and stay.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { generateKey } from '@md-runbook/ssh';
import { newFileName, newRunbookText, resetDrafts, signatureBreaks, titleFromFileName } from '../runbooks/editing';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { RunbookEditor, lineOffset } from '../screens/RunbookEditor';
import { RunbookList } from '../screens/RunbookList';
import { RunbookView } from '../screens/RunbookView';
import { resetSettings, setOutputSetting } from '../settings/store';
import { inputText } from '../testing/inputText';
import { signPlan, signRunbook } from '../signing/sign';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
/** A Pixel 9 Pro's width in dp, unless a test sets another. */
let mockWidth = 412;
let mockFontScale = 1;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 900, scale: 2, fontScale: mockFontScale }),
}));

const RUNBOOK = '# Restart the API\n\nWhen it hangs.\n\n```bash\nsystemctl restart api\n```\n';
const OUTPUT = '<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';

async function signed(text = RUNBOOK): Promise<string> {
  const r = await signRunbook(
    text,
    signPlan(text, 'restart.md'),
    { name: 'restart', scopes: '', days: '', patterns: {} },
    'ana@example.net',
    await generateKey(),
  );
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.text;
}
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

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunbooks();
  resetSettings();
  // Highlighted while editing, as on Android by default (off by default on iOS, this project).
  setOutputSetting('highlightEditing', true);
  resetDrafts();
  jest.clearAllMocks();
  mockWidth = 412;
  mockFontScale = 1;
});

describe('editing (the logic)', () => {
  it('warns only when a matching signature would no longer match', async () => {
    const text = await signed();
    expect(signatureBreaks(text, text.replace('When it hangs.', 'When it is slow.'))).toEqual({
      signer: 'ana@example.net',
      name: 'restart',
      version: 1,
    });
    // The signature gone from the text: it breaks too.
    expect(signatureBreaks(text, RUNBOOK)).toBeDefined();
    // Outputs aren't signed; nothing matched before; nothing signed.
    expect(signatureBreaks(text, text.replace('systemctl restart api\n```\n', `systemctl restart api\n\`\`\`\n${OUTPUT}`))).toBeUndefined();
    expect(signatureBreaks(text.replace('When it hangs.', 'x'), text.replace('When it hangs.', 'y'))).toBeUndefined();
    expect(signatureBreaks(RUNBOOK, 'other')).toBeUndefined();
  });

  it('a new runbook: its file name, its title, blank or from the template', () => {
    expect(newFileName('restart-api', [])).toEqual({ name: 'restart-api.md' });
    expect(newFileName(' ', [])).toEqual({ problem: 'Enter a file name.' });
    expect(newFileName('ops/x.md', [])).toEqual({ problem: 'A file name only, without folders.' });
    expect(newFileName('Restart-API.md', [{ fileName: 'restart-api.md' }])).toEqual({
      problem: 'A runbook with this file name is in the app already.',
    });
    expect(titleFromFileName('restart-api.runbook.md')).toBe('Restart api');
    expect(newRunbookText('restart-api.md', false)).toBe('# Restart api\n');
    expect(newRunbookText('restart-api.md', true)).toContain('```bash name="Check the host"\nhostname && uptime\n```');
    expect(lineOffset('a\nbc\nd', 2)).toBe(5);
  });
});

describe('the editor', () => {
  it('Edit: unsaved changes, Undo, Save; Preview draws it without Run buttons', async () => {
    const r = addRunbook('restart.md', RUNBOOK + OUTPUT);
    await render(<RunbookEditor id={r.id} />);
    expect(inputText(screen.getByTestId('editor-text'))).toBe(RUNBOOK + OUTPUT);
    // Its outputs are text, kept as they are.
    expect(screen.getByTestId('editor-notes')).toHaveTextContent(/md-runbook:output blocks/);
    await type('editor-text', RUNBOOK.replace('When it hangs.', 'When it hangs or is slow.') + OUTPUT);
    expect(screen.getByTestId('editor-state')).toHaveTextContent('Unsaved changes');
    expect(getRunbook(r.id)!.text).toBe(RUNBOOK + OUTPUT);
    await press('editor-undo');
    expect(inputText(screen.getByTestId('editor-text'))).toBe(RUNBOOK + OUTPUT);
    await type('editor-text', '# Restart the API\n\nWhen it is slow.\n');
    await press('editor-save');
    expect(getRunbook(r.id)!.text).toBe('# Restart the API\n\nWhen it is slow.\n');
    expect(screen.getByTestId('editor-state')).toHaveTextContent('Saved.');
    await press('editor-mode-preview');
    expect(screen.getByTestId('editor-preview')).toHaveTextContent(/Restart the API.*When it is slow\./);
    expect(screen.queryByTestId('editor-text')).toBeNull();
  });

  it.each([
    ['a small phone', 320, 1, false],
    ['a Pixel 9 Pro', 412, 1, false],
    ['a large phone', 430, 1, false],
    ['a tablet with large text', 820, 1.5, false],
    ['a tablet', 820, 1, true],
  ])('the toolbar on %s (%i dp): Undo, Discard, the state and Save', async (_, width, fontScale, oneRow) => {
    mockWidth = width;
    mockFontScale = fontScale;
    const r = addRunbook('restart.md', RUNBOOK);
    await render(<RunbookEditor id={r.id} />);
    await type('editor-text', RUNBOOK + 'More.\n');
    const toolbar = screen.getByTestId('editor-toolbar');
    expect(within(toolbar).getByLabelText('Undo')).toBeEnabled();
    expect(within(toolbar).getByLabelText('Discard')).toBeEnabled();
    expect(within(toolbar).getByLabelText('Save')).toBeEnabled();
    expect(screen.getByTestId('editor-state')).toHaveTextContent('Unsaved changes');
    expect(screen.getByRole('status')).toBe(screen.getByTestId('editor-state'));
    // Narrow: the state on its own line, so the row holds the buttons only; wide: one row, as before.
    expect(within(toolbar).queryByTestId('editor-state') !== null).toBe(oneRow);
    // Save is last in its row (right-aligned, after a wrap too).
    expect(toolbar.children.at(-1)).toBe(within(toolbar).getByTestId('editor-save'));
  });

  it('lists lint problems; a tap goes back to the text', async () => {
    const r = addRunbook('restart.md', '# R\n\n```bash timout=5\nuptime\n```\n');
    await render(<RunbookEditor id={r.id} />);
    expect(screen.getByTestId('editor-problem-0')).toHaveTextContent(/Line 3: .*timout/);
    await press('editor-problem-0');
    expect(screen.getByTestId('editor-text').props.selection).toEqual({ start: 5, end: 5 });
    // The field's own selection after that.
    await act(async () => {
      fireEvent(screen.getByTestId('editor-text'), 'selectionChange', { nativeEvent: { selection: { start: 9, end: 9 } } });
    });
    expect(screen.getByTestId('editor-text').props.selection).toBeUndefined();
  });

  it('Highlight while editing off: the same editing with a plain value', async () => {
    setOutputSetting('highlightEditing', false);
    const r = addRunbook('restart.md', RUNBOOK);
    await render(<RunbookEditor id={r.id} />);
    expect(screen.getByTestId('editor-text').props.value).toBe(RUNBOOK);
    await type('editor-text', RUNBOOK + 'More.\n');
    expect(screen.getByTestId('editor-state')).toHaveTextContent('Unsaved changes');
    await press('editor-undo');
    expect(screen.getByTestId('editor-text').props.value).toBe(RUNBOOK);
    await type('editor-text', RUNBOOK + 'Saved.\n');
    await press('editor-save');
    expect(getRunbook(r.id)!.text).toBe(RUNBOOK + 'Saved.\n');
  });

  it('saving a signed runbook whose signed text changed asks first', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const text = await signed();
    const r = addRunbook('restart.md', text);
    await render(<RunbookEditor id={r.id} />);
    await type('editor-text', text.replace('When it hangs.', 'When it is slow.'));
    await press('editor-save');
    expect(alert).toHaveBeenCalledWith(
      'The signature will no longer match.',
      expect.stringContaining('Signed by ana@example.net as restart version 1.'),
      expect.any(Array),
    );
    expect(getRunbook(r.id)!.text).toBe(text);
    await act(async () => alert.mock.calls[0]![2]!.find((b) => b.text === 'Save')!.onPress!());
    expect(getRunbook(r.id)!.text).toContain('When it is slow.');
  });

  it('Runbook: unsaved text asks Save first; the draft is kept when leaving without saving', async () => {
    const r = addRunbook('restart.md', RUNBOOK);
    const view = await render(<RunbookEditor id={r.id} />);
    await type('editor-text', RUNBOOK + '\nMore.\n');
    await press('editor-mode-runbook');
    expect(screen.getByTestId('editor-leave')).toHaveTextContent(/Save your changes first\?/);
    await press('editor-leave-unsaved');
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/runbook/[id]', params: { id: r.id } });
    expect(getRunbook(r.id)!.text).toBe(RUNBOOK);
    // Opened again (a new screen): the unsaved text is still there.
    await view.rerender(<RunbookEditor key="again" id={r.id} />);
    expect(inputText(screen.getByTestId('editor-text'))).toBe(RUNBOOK + '\nMore.\n');
    await press('editor-mode-runbook');
    await press('editor-leave-save');
    expect(getRunbook(r.id)!.text).toBe(RUNBOOK + '\nMore.\n');
  });

  it('a link copy says edits stay yours', async () => {
    const r = addRunbook('restart.md', RUNBOOK, undefined, 'https://example.net/x.md abc');
    await render(<RunbookEditor id={r.id} />);
    expect(screen.getByTestId('editor-notes')).toHaveTextContent(/opened from a link: edits stay on this device/);
  });
});

describe('entries', () => {
  it('⋯ More → Edit as Text opens the editor', async () => {
    const r = addRunbook('restart.md', RUNBOOK);
    await render(<RunbookView id={r.id} />);
    await press('more-actions');
    await press('action-editAsText');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/edit/[id]', params: { id: r.id, from: 'runbook' } });
  });

  it('New runbook… makes one from the template and opens it as text', async () => {
    await render(<RunbookList />);
    await press('new-runbook');
    expect(screen.getByTestId('new-runbook-create')).toBeDisabled();
    await type('new-runbook-name', 'restart-api');
    await press('new-runbook-create');
    const call = jest.mocked(router.push).mock.calls[0]![0] as { pathname: string; params: { id: string } };
    expect(call.pathname).toBe('/edit/[id]');
    const made = getRunbook(call.params.id)!;
    expect(made.fileName).toBe('restart-api.md');
    expect(made.text).toContain('# Restart api');
    expect(made.text).toContain('hostname && uptime');
  });
});

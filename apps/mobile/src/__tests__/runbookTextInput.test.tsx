/**
 * Edit as Text on iOS and Android (ui/RunbookTextInput.tsx), in the "ios" Jest project: the
 * text input's text as coloured <Text> children (Highlight while editing, on by default), or the
 * plain input with a value when the setting is off or the text is too long. The screen around it
 * is tested in editor.test.tsx. How the cursor behaves while typing is the platforms' (see the
 * file's header): checked on a device.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { HIGHLIGHT_KINDS, type HighlightKind } from '../editor/highlight';
import { HostList } from '../screens/HostList';
import { outputSettings, resetSettings, setOutputSetting } from '../settings/store';
import { inputText } from '../testing/inputText';
import { light } from '../theme';
import { DEFER_FROM, HIGHLIGHT_MAX, RunbookTextInput, drawLines, editorLines, type EditorLine } from '../ui/RunbookTextInput';
import type { RunbookTextInputHandle, RunbookTextInputProps } from '../ui/runbookTextInputProps';

jest.mock('expo-router', () => ({ Link: ({ children }: { children: unknown }) => children }));
jest.mock('../ssh/appKey', () => ({
  appPublicKeyLine: async () => 'ecdsa-sha2-nistp256 AAAA md-runbook',
  appKeyInfo: async () => ({ storage: 'secure-store' }),
}));

const RUNBOOK = [
  '---',
  'title: Restart',
  '---',
  '# Restart the **API**',
  '',
  'When it *hangs*, see [the wiki](https://wiki.example.net/api) or <https://status.example.net>.',
  '',
  '- [ ] Tell the channel',
  '1. Check `uptime` first',
  '> Careful.',
  '',
  '```bash timeout=30 skip',
  'systemctl restart api',
  '```',
  '<!-- md-runbook:output start exit=0 -->',
  '```text',
  'ok',
  '```',
  '<!-- md-runbook:output end -->',
  '<!-- md-runbook:note by=ana at=2026-11-16 -->',
  '> it came back',
  '<!-- a comment -->',
  '<!-- md-runbook:signature v1 signer=ana@example.net signed=2026-11-16',
  'AAAA',
  '-->',
  '',
].join('\n');

interface Node {
  type: string;
  props: { style?: { color?: string; textDecorationLine?: string } };
  children: (Node | string)[] | null;
}

/** The coloured pieces in the input: [text, colour], in order. */
function coloured(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (n: Node | string): void => {
    if (typeof n === 'string') return;
    const color = n.props.style?.color;
    if (n.type === 'Text' && color) out.push([(n.children ?? []).join(''), color]);
    else n.children?.forEach(walk);
  };
  walk(screen.getByTestId('editor-text') as unknown as Node);
  return out;
}

async function mount(value: string, extra: Partial<RunbookTextInputProps> = {}) {
  const ref = createRef<RunbookTextInputHandle>();
  const onChangeText = jest.fn();
  const onSelectionChange = jest.fn();
  const props = { ref, testID: 'editor-text', accessibilityLabel: 'Runbook text (Markdown)', onChangeText, onSelectionChange, style: {} };
  const view = await render(<RunbookTextInput {...props} {...extra} value={value} />);
  const again = async (v: string, more: Partial<RunbookTextInputProps> = {}) =>
    view.rerender(<RunbookTextInput {...props} {...extra} {...more} value={v} />);
  return { ref, onChangeText, onSelectionChange, again, input: () => screen.getByTestId('editor-text') };
}

beforeEach(() => resetSettings());

it('iOS and Android take this file', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expect(require('../ui/RunbookTextInput').RunbookTextInput).toBe(RunbookTextInput);
});

describe('highlighted (the default)', () => {
  it('the text as coloured children, one colour per kind, spelling the value exactly', async () => {
    expect(outputSettings().highlightEditing).toBe(true);
    const { input } = await mount(RUNBOOK);
    expect(input().props.value).toBeUndefined();
    expect(inputText(input())).toBe(RUNBOOK);
    // Each kind's pieces, in its colour from the theme.
    const expected = drawLines(RUNBOOK).flatMap((l) =>
      l.parts.flatMap(([kind, text]): [string, string][] => (kind ? [[text, light.highlight[kind]]] : [])),
    );
    expect(coloured()).toEqual(expected);
    const kinds = new Set(drawLines(RUNBOOK).flatMap((l) => l.parts.flatMap(([k]) => (k ? [k] : []))));
    expect([...kinds].sort()).toEqual([...HIGHLIGHT_KINDS].sort());
    const colourOf = (text: string) => coloured().find(([t]) => t === text)?.[1];
    const want: [string, HighlightKind][] = [
      ['# Restart the ', 'heading'],
      ['**API**', 'bold'],
      ['bash', 'fenceLang'],
      ['timeout', 'option'],
      ['30', 'optionValue'],
      ['systemctl restart api', 'code'],
      ['<!-- a comment -->', 'comment'],
    ];
    for (const [text, kind] of want) expect([text, colourOf(text)]).toEqual([text, light.highlight[kind]]);
  });

  it('keeps editing as it was: no autocorrect, spellcheck or capitals; multiline', async () => {
    const { input } = await mount(RUNBOOK);
    expect(input().props).toMatchObject({ autoCorrect: false, spellCheck: false, autoCapitalize: 'none', multiline: true });
    expect(input().props.accessibilityLabel).toBe('Runbook text (Markdown)');
  });

  it('CRLF, a lone CR, an empty text and a last line without a break, exactly', async () => {
    const { input, again } = await mount('# A\r\nb\rc\n\n');
    expect(inputText(input())).toBe('# A\r\nb\rc\n\n');
    await again('');
    expect(inputText(input())).toBe('');
    expect(input().props.value).toBeUndefined();
    await again('x');
    expect(inputText(input())).toBe('x');
  });

  it('a change goes to the screen; the children follow the new value', async () => {
    const { input, onChangeText, again } = await mount(RUNBOOK);
    const next = RUNBOOK.replace('# Restart the **API**', '## Restart the API');
    await act(async () => {
      fireEvent.changeText(input(), next);
    });
    expect(onChangeText).toHaveBeenCalledWith(next);
    await again(next);
    expect(inputText(input())).toBe(next);
    expect(coloured()).toContainEqual(['## Restart the API', light.highlight.heading]);
    expect(coloured()).not.toContainEqual(['**API**', light.highlight.bold]);
  });

  it('the selection: the field’s own goes to the screen; one the screen sets is passed on; focus', async () => {
    const { input, onSelectionChange, again, ref } = await mount(RUNBOOK);
    expect(input().props.selection).toBeUndefined();
    await act(async () => {
      fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: 3, end: 7 } } });
    });
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 3, end: 7 });
    // A problem's line: the screen sets the selection, then lets go of it.
    await again(RUNBOOK, { selection: { start: 12, end: 12 } });
    expect(input().props.selection).toEqual({ start: 12, end: 12 });
    expect(inputText(input())).toBe(RUNBOOK);
    await again(RUNBOOK, { selection: undefined });
    expect(input().props.selection).toBeUndefined();
    expect(() => ref.current!.focus()).not.toThrow();
  });
});

describe('Highlight while editing off', () => {
  it('the plain input with its value, as before; switching back colours it again', async () => {
    setOutputSetting('highlightEditing', false);
    const { input, onChangeText, onSelectionChange } = await mount(RUNBOOK, { selection: { start: 1, end: 1 } });
    expect(input().props.value).toBe(RUNBOOK);
    expect(input().children).toEqual([]);
    expect(input().props).toMatchObject({ autoCorrect: false, spellCheck: false, autoCapitalize: 'none', selection: { start: 1, end: 1 } });
    await act(async () => {
      fireEvent.changeText(input(), 'x');
      fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 1 } } });
    });
    expect(onChangeText).toHaveBeenCalledWith('x');
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 0, end: 1 });
    await act(async () => setOutputSetting('highlightEditing', true));
    expect(input().props.value).toBeUndefined();
    expect(inputText(input())).toBe(RUNBOOK);
    expect(coloured().length).toBeGreaterThan(0);
  });

  it('Hosts & settings → Edit as Text: the toggle, on by default', async () => {
    await render(<HostList />);
    const toggle = screen.getByTestId('setting-highlightEditing');
    expect(screen.getByTestId('editor-settings')).toHaveTextContent(/Edit as Text.*Highlight while editing/);
    expect(toggle.props.accessibilityState).toMatchObject({ checked: true });
    await act(async () => {
      fireEvent.press(toggle);
    });
    expect(outputSettings().highlightEditing).toBe(false);
  });
});

describe('long texts', () => {
  it('above HIGHLIGHT_MAX characters: the plain input; back under it: coloured', async () => {
    // Long lines, so the test renders few elements.
    const line = '# ' + 'x'.repeat(9_997) + '\n';
    const big = line.repeat(HIGHLIGHT_MAX / line.length) + 'y';
    expect(big.length).toBe(HIGHLIGHT_MAX + 1);
    const { input, again } = await mount(big);
    expect(input().props.value).toBe(big);
    expect(input().children).toEqual([]);
    const small = big.slice(0, HIGHLIGHT_MAX);
    await again(small);
    expect(input().props.value).toBeUndefined();
    expect(inputText(input())).toBe(small);
    expect(coloured()[0]).toEqual([line.slice(0, -1), light.highlight.heading]);
  });

  it('from DEFER_FROM characters: coloured, and while the colours catch up the changed lines are plain', async () => {
    const long = '# Title\n' + ('Some *text*. '.repeat(400) + '\n').repeat(Math.ceil(DEFER_FROM / 5_201));
    expect(long.length).toBeGreaterThanOrEqual(DEFER_FROM);
    const { input } = await mount(long);
    expect(inputText(input())).toBe(long);
    expect(coloured()).toContainEqual(['# Title', light.highlight.heading]);
    // As rendered before the colours catch up: the old text's colours on the lines both share.
    const old = '# Title\nSome *text*.\n```bash\nls\n```\n';
    const now = '# Title\nSome *text*.\n```bash timeout=5\nls\n```\r\n';
    const { lines } = editorLines(now, { text: old, lines: drawLines(old) }, undefined);
    expect(lines.map((l) => l.text + l.brk).join('')).toBe(now);
    expect(lines[1]!.parts).toEqual(drawLines(old)[1]!.parts);
    expect(lines[2]!.parts).toEqual([[undefined, '```bash timeout=5']]);
    expect(lines[4]!.parts).toEqual([['fence', '```']]);
    expect(lines[4]!.brk).toBe('\r\n');
  });
});

describe('lines keep their keys (only changed lines re-render)', () => {
  const keys = (lines: EditorLine[]) => lines.map((l) => l.key);
  const step = (text: string, previous?: EditorLine[]) => editorLines(text, { text, lines: drawLines(text) }, previous).lines;

  it('typing in a line, Enter, and removing a line', () => {
    const first = step('a\nb\nc\n');
    expect(keys(first)).toEqual(['0', '1', '2', '3']);
    const typed = step('a\nbx\nc\n', first);
    expect(keys(typed)).toEqual(['0', '1', '2', '3']);
    const entered = step('a\nb\nx\nc\n', typed);
    expect(keys(entered)).toEqual(['0', '1', 'n0', '2', '3']);
    const removed = step('a\nc\n', entered);
    expect(keys(removed)).toEqual(['0', '2', '3']);
    // Same lines twice: still a key each.
    const twice = step('a\na\na\n', step('a\na\n'));
    expect(new Set(keys(twice)).size).toBe(twice.length);
  });
});

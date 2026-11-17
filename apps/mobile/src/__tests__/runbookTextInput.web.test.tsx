/**
 * Edit as Text in the browser (ui/RunbookTextInput.web.tsx), in jsdom with react-native-web (the
 * "web" Jest project): a textarea over a highlighted drawing of the same text. The screen around
 * it is tested in editor.test.tsx with the iOS text input; here, the same flow through the
 * textarea: the text in, each change out, Tab, a selection set by the screen, focus, long texts.
 * jsdom has no layout, so how the letters line up is checked in the browser (e2e/web-smoke.mjs).
 */
import { act, createElement, createRef, type ReactNode } from 'react';
import type { RunbookTextInputHandle, RunbookTextInputProps } from '../ui/runbookTextInputProps';
import { HIGHLIGHT_MAX, INDENT, RunbookTextInput, sameParts } from '../ui/RunbookTextInput.web';
import { light } from '../theme';

it('the web build takes the web file', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expect(require('../ui/RunbookTextInput').RunbookTextInput).toBe(RunbookTextInput);
});

// React DOM, as the web build renders (the app has no @types/react-dom).
const { createRoot } = jest.requireActual<{ createRoot: (el: Element) => { render(node: ReactNode): void; unmount(): void } }>(
  'react-dom/client',
);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUNBOOK = '# Restart the API\n\n```bash timeout=30\nsystemctl restart api\n```\n';

async function mount(value: string, extra: Partial<RunbookTextInputProps> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = createRef<RunbookTextInputHandle>();
  const onChangeText = jest.fn();
  const onSelectionChange = jest.fn();
  const props = { ref, testID: 'editor-text', accessibilityLabel: 'Runbook text (Markdown)', onChangeText, onSelectionChange, style: {} };
  const render = async (v: string, more: Partial<RunbookTextInputProps> = {}) =>
    act(async () => root.render(createElement(RunbookTextInput, { ...props, ...extra, ...more, value: v })));
  await render(value);
  const area = host.querySelector('textarea')!;
  const layer = host.querySelector('pre')!;
  return { host, root, ref, onChangeText, onSelectionChange, render, area, layer };
}

/** Types into the textarea as the browser does: a new value, then an input event. */
function typeInto(area: HTMLTextAreaElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  set.call(area, value);
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

const key = (area: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void area.dispatchEvent(e));
  return e;
};

describe('the web editor', () => {
  it('a labelled textarea over a drawing with one line per line, coloured by kind', async () => {
    const { host, area, layer, root } = await mount(RUNBOOK);
    expect(host.querySelector('[data-testid="editor-text"]')).not.toBeNull();
    expect(area.value).toBe(RUNBOOK);
    expect(area.getAttribute('aria-label')).toBe('Runbook text (Markdown)');
    expect(area.getAttribute('spellcheck')).toBe('false');
    expect(area.style.color).toBe('transparent');
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    // 6 lines: the text ends with a line break, so the last is empty (as the textarea shows it).
    const lines = [...layer.children] as HTMLElement[];
    expect(lines.map((l) => l.textContent)).toEqual(RUNBOOK.split('\n'));
    const colour = (text: string): string | undefined =>
      ([...layer.querySelectorAll('span')] as HTMLElement[]).find((s) => s.textContent === text)?.style.color;
    const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(colour('# Restart the API')).toBe(rgb(light.highlight.heading));
    expect(colour('bash')).toBe(rgb(light.highlight.fenceLang));
    expect(colour('timeout')).toBe(rgb(light.highlight.option));
    expect(colour('30')).toBe(rgb(light.highlight.optionValue));
    expect(colour('systemctl restart api')).toBe(rgb(light.highlight.code));
    await act(async () => root.unmount());
  });

  it('typing: each change goes to the screen, and the drawing follows its value', async () => {
    const { area, layer, onChangeText, onSelectionChange, render, root } = await mount(RUNBOOK);
    act(() => typeInto(area, 'x' + RUNBOOK));
    expect(onChangeText).toHaveBeenLastCalledWith('x' + RUNBOOK);
    await render('x' + RUNBOOK);
    expect(layer.children[0]!.textContent).toBe('x# Restart the API');
    // The screen's Undo or Discard: the field and the drawing show its text.
    await render(RUNBOOK);
    expect(area.value).toBe(RUNBOOK);
    expect(layer.children[0]!.textContent).toBe('# Restart the API');
    // A click or the arrow keys move the selection (React's onSelect: the focused field, on keyup).
    act(() => {
      area.focus();
      area.setSelectionRange(2, 4);
      area.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 2, end: 4 });
    await act(async () => root.unmount());
  });

  it('a line is drawn again when its kinds change, even with the same text', async () => {
    const { layer, render, root } = await mount('x\n# A\n');
    const colour = (): string => (layer.children[1]!.firstElementChild as HTMLElement).style.color;
    const heading = colour();
    // A fence opens above it: the same text is code now.
    await render('```\n# A\n');
    expect(layer.children[1]!.textContent).toBe('# A');
    expect(colour()).not.toBe(heading);
    // Lines are compared piece by piece: no two different lines look alike (a joined key could).
    expect(
      sameParts(
        [[undefined, 'x\u0001heading\u0000y']],
        [
          [undefined, 'x'],
          ['heading', 'y'],
        ],
      ),
    ).toBe(false);
    expect(sameParts([['code', 'a']], [['code', 'a']])).toBe(true);
    expect(sameParts([['code', 'a']], [['heading', 'a']])).toBe(false);
    await act(async () => root.unmount());
  });

  it('Tab puts two spaces in the text; Shift+Tab, or Escape then Tab, leaves the field', async () => {
    const { area, onChangeText, render, root } = await mount('ab');
    area.setSelectionRange(1, 1);
    const tab = key(area, { key: 'Tab' });
    expect(tab.defaultPrevented).toBe(true);
    expect(INDENT).toBe('  ');
    expect(onChangeText).toHaveBeenLastCalledWith('a  b');
    await render('a  b');
    expect([area.selectionStart, area.selectionEnd]).toEqual([3, 3]);
    onChangeText.mockClear();
    expect(key(area, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(false);
    key(area, { key: 'Escape' });
    expect(key(area, { key: 'Tab' }).defaultPrevented).toBe(false);
    expect(onChangeText).not.toHaveBeenCalled();
    // The Escape counts for one Tab only.
    expect(key(area, { key: 'Tab' }).defaultPrevented).toBe(true);
    await act(async () => root.unmount());
  });

  it("a selection the screen sets (a problem's line), and focus", async () => {
    const { area, ref, render, root } = await mount(RUNBOOK);
    await render(RUNBOOK, { selection: { start: 19, end: 19 } });
    expect([area.selectionStart, area.selectionEnd]).toEqual([19, 19]);
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(area);
    await act(async () => root.unmount());
  });

  it('a text over the limit is plain: no drawing, the letters show', async () => {
    const big = '# x\n'.repeat(Math.ceil(HIGHLIGHT_MAX / 4) + 1);
    const { area, layer, root } = await mount(big);
    expect(layer.children).toHaveLength(0);
    expect(area.style.color).not.toBe('transparent');
    expect(area.value).toBe(big);
    await act(async () => root.unmount());
  });
});

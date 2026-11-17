/**
 * Edit as Text in the browser: a real <textarea> with see-through text over a <pre> that draws the
 * same text highlighted (editor/highlight.ts), with line numbers. Same props as the text input on
 * iOS and Android (RunbookTextInput.tsx), so the screen works the same.
 *
 * - The textarea does the editing: undo, IME, selection, screen readers, the browser's find.
 * - Both use the same font, size, line height, padding, tab size and wrapping, and the <pre>
 *   follows the textarea's scrolling, so the colours sit under the letters. Colour only: a bold
 *   letter could be wider.
 * - The <pre> has one block per line, so a line number stays with its line when it wraps.
 * - Long texts: from DEFER_FROM characters the colours follow a moment after typing (the letters
 *   show plain meanwhile); above HIGHLIGHT_MAX the text stays plain.
 */
import { memo, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { View } from 'react-native';
import { highlight, lineRuns, type HighlightKind } from '../editor/highlight';
import { mono, usePalette } from '../theme';
import { DEFER_FROM, HIGHLIGHT_MAX, type RunbookTextInputProps } from './runbookTextInputProps';

export { DEFER_FROM, HIGHLIGHT_MAX };

const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PAD = 10;
const TAB_SIZE = 4;
/** Tab: these spaces. */
export const INDENT = '  ';

// What inline styles can't say: line numbers (a counter before each line) and the selection.
const CSS = `
.mdrb-hl { counter-reset: mdrb-line; }
.mdrb-hl > div { position: relative; min-height: ${LINE_HEIGHT}px; counter-increment: mdrb-line; }
.mdrb-hl > div::before {
  content: counter(mdrb-line); position: absolute; right: 100%; padding-right: 12px;
  color: var(--mdrb-gutter); white-space: nowrap;
}
.mdrb-input::selection { background: var(--mdrb-selection); }
.mdrb-input:focus { outline: none; }
.mdrb-input:focus-visible { outline: 2px solid var(--mdrb-accent); outline-offset: -2px; }
`;

/** The 0-based line of an offset (CRLF, lone CR or LF end a line). */
function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
  }
  return line;
}

const countLines = (text: string): number => lineAt(text, text.length) + 1;

type Part = [kind: HighlightKind | undefined, text: string];

/** The same pieces: each kind and text compared, so no two different lines look alike. */
export const sameParts = (a: readonly Part[], b: readonly Part[]): boolean =>
  a.length === b.length && a.every(([k, t], i) => b[i]![0] === k && b[i]![1] === t);

/** One line of the drawing; redrawn only when its text or colours change. */
const Line = memo(
  function Line({ parts, colors }: { parts: Part[]; colors: Record<HighlightKind, string> }) {
    return (
      <div>
        {parts.map(([kind, text], i) =>
          kind ? (
            <span key={i} style={{ color: colors[kind], ...(kind === 'linkUrl' ? { textDecoration: 'underline' } : {}) }}>
              {text}
            </span>
          ) : (
            <span key={i}>{text}</span>
          ),
        )}
      </div>
    );
  },
  (a, b) => a.colors === b.colors && sameParts(a.parts, b.parts),
);

export function RunbookTextInput({
  ref,
  testID,
  accessibilityLabel,
  value,
  onChangeText,
  selection,
  onSelectionChange,
  style,
}: RunbookTextInputProps) {
  const c = usePalette();
  const area = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  /** A selection to set after the next render (Tab where the browser can't insert text itself). */
  const pending = useRef<{ start: number; end: number } | undefined>(undefined);
  /** Escape, then Tab: Tab leaves the field. */
  const escaped = useRef(false);
  const deferred = useDeferredValue(value);
  const shown = value.length >= DEFER_FROM ? deferred : value;
  const lines = useMemo(() => {
    if (shown.length > HIGHLIGHT_MAX) return undefined;
    return lineRuns(shown, highlight(shown)).map((l) =>
      l.runs.map((r): Part => [r.kinds[r.kinds.length - 1], shown.slice(r.start, r.end)]),
    );
  }, [shown]);
  // The drawing matches the field only when it shows the same text.
  const drawn = lines !== undefined && shown === value;
  const digits = String(lines?.length ?? countLines(value)).length;
  const gutter = `calc(${Math.max(2, digits)}ch + ${PAD + 14}px)`;

  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  const sync = (): void => {
    const a = area.current;
    const l = layer.current;
    if (!a || !l) return;
    // The textarea's scroll bar narrows its text; the drawing keeps the same width.
    l.style.paddingRight = `${PAD + Math.max(0, a.offsetWidth - a.clientWidth)}px`;
    l.scrollTop = a.scrollTop;
    l.scrollLeft = a.scrollLeft;
  };
  useLayoutEffect(() => {
    if (pending.current && area.current) {
      area.current.setSelectionRange(pending.current.start, pending.current.end);
      pending.current = undefined;
    }
    sync();
  });
  useEffect(() => {
    const a = area.current;
    if (!a || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => sync());
    watch.observe(a);
    return () => watch.disconnect();
  }, []);
  // A selection the screen sets (a problem's line): there, and scrolled into view.
  useLayoutEffect(() => {
    const a = area.current;
    if (!selection || !a) return;
    a.setSelectionRange(selection.start, selection.end);
    const line = lineAt(a.value, selection.start);
    const el = layer.current?.children[line] as HTMLElement | undefined;
    const top = el ? el.offsetTop : PAD + line * LINE_HEIGHT;
    if (top < a.scrollTop || top + LINE_HEIGHT > a.scrollTop + a.clientHeight) a.scrollTop = Math.max(0, top - a.clientHeight / 3);
    sync();
  }, [selection]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      escaped.current = true;
      return;
    }
    const leave = escaped.current;
    escaped.current = false;
    // Tab puts spaces in the text; Shift+Tab, or Escape then Tab, leaves the field.
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || leave) return;
    e.preventDefault();
    const a = e.currentTarget;
    // Through the browser's editing, so its undo takes it back.
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, INDENT)) return;
    const { selectionStart: start, selectionEnd: end } = a;
    pending.current = { start: start + INDENT.length, end: start + INDENT.length };
    onChangeText(a.value.slice(0, start) + INDENT + a.value.slice(end));
  };

  const box = {
    position: 'absolute',
    inset: 0,
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
    margin: 0,
    border: 0,
    paddingTop: PAD,
    paddingBottom: PAD,
    paddingLeft: gutter,
    paddingRight: PAD,
    fontFamily: mono,
    fontSize: FONT_SIZE,
    lineHeight: `${LINE_HEIGHT}px`,
    letterSpacing: 'normal',
    fontVariantLigatures: 'none',
    fontKerning: 'none',
    tabSize: TAB_SIZE,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'normal',
    textAlign: 'left',
  } as const;
  return (
    <View testID={testID} style={[style, { padding: 0, overflow: 'hidden' }]}>
      <style>{CSS}</style>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <pre
          ref={layer}
          aria-hidden
          className="mdrb-hl"
          style={{
            ...box,
            // Room to follow the textarea to its very end.
            paddingBottom: PAD + 40,
            overflow: 'hidden',
            pointerEvents: 'none',
            userSelect: 'none',
            color: c.text,
            visibility: drawn ? 'visible' : 'hidden',
            ['--mdrb-gutter' as string]: c.gutter,
          }}
        >
          {lines?.map((l, i) => (
            <Line key={i} parts={l} colors={c.highlight} />
          ))}
        </pre>
        <textarea
          ref={area}
          className="mdrb-input"
          data-testid={`${testID}-input`}
          aria-label={accessibilityLabel}
          value={value}
          onChange={(e) => onChangeText(e.currentTarget.value)}
          onSelect={(e) => onSelectionChange({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
          onScroll={sync}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          wrap="soft"
          style={{
            ...box,
            overflowX: 'hidden',
            overflowY: 'auto',
            resize: 'none',
            background: 'transparent',
            // The letters are the drawing's; the caret and the selection are the textarea's.
            color: drawn ? 'transparent' : c.text,
            caretColor: c.text,
            ['--mdrb-selection' as string]: c.dark ? 'rgba(38, 79, 120, 0.6)' : 'rgba(173, 214, 255, 0.6)',
            ['--mdrb-accent' as string]: c.accent,
          }}
        />
      </div>
    </View>
  );
}

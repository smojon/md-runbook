/**
 * Edit as Text on iOS and Android: the runbook's Markdown in a multiline text input. With
 * Hosts & settings → Edit as Text → Highlight while editing (on by default), the input's text is
 * nested <Text> children, coloured as the web's editor colours it (editor/highlight.ts, the
 * theme's Palette.highlight). Off, it is the plain input with a value, as before.
 *
 * - The children always spell the value exactly, line breaks included: the input takes its text
 *   from them, so a different text would undo typing.
 * - One <Text> per line, memoised. A line keeps its key while it is edited, and the lines before
 *   and after a change keep theirs, so typing or Enter re-renders only the changed lines in React.
 *   The native side still lays out the whole text after each change.
 * - From DEFER_FROM characters the colours follow a moment after typing: meanwhile the changed
 *   lines show plain and the others keep their colours. Above HIGHLIGHT_MAX: the plain input.
 * - The cursor stays where it is without a controlled selection. React Native applies a text
 *   from React only once it has seen every change the input sent (an event count), and then
 *   keeps the cursor's place: Android replaces the text in place, iOS counts the cursor from the
 *   end (a selection then becomes a cursor). So, as before, the selection is set only when the
 *   screen sets one (a problem's line).
 */
import { memo, useDeferredValue, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Text, TextInput, type TextInputInstance, type TextStyle } from 'react-native';
import { HIGHLIGHT_KINDS, highlight, lineBounds, lineRuns, type HighlightKind } from '../editor/highlight';
import { useOutputSettings } from '../settings/store';
import { usePalette, type Palette } from '../theme';
import { DEFER_FROM, HIGHLIGHT_MAX, type RunbookTextInputProps } from './runbookTextInputProps';

export { DEFER_FROM, HIGHLIGHT_MAX };

type Part = [kind: HighlightKind | undefined, text: string];

/** A line of the text: its text, its pieces, and the line break after it ('' for the last). */
export interface DrawnLine {
  text: string;
  parts: readonly Part[];
  brk: string;
}

/** A line as the input shows it, with its React key. */
export interface EditorLine extends DrawnLine {
  key: string;
}

/** The same pieces: each kind and text compared, so no two different lines look alike. */
const sameParts = (a: readonly Part[], b: readonly Part[]): boolean =>
  a.length === b.length && a.every(([k, t], i) => b[i]![0] === k && b[i]![1] === t);

/** The highlighted lines of a text. */
export function drawLines(text: string): DrawnLine[] {
  const lines = lineRuns(text, highlight(text));
  return lines.map((l, i) => ({
    text: text.slice(l.start, l.end),
    parts: l.runs.map((r): Part => [r.kinds[r.kinds.length - 1], text.slice(r.start, r.end)]),
    brk: i + 1 < lines.length ? text.slice(l.end, lines[i + 1]!.start) : '',
  }));
}

/** The plain lines of a text: each line's text as its only piece (none when empty). */
function plainLines(text: string): DrawnLine[] {
  const { starts, ends } = lineBounds(text);
  return starts.map((s, i) => {
    const line = text.slice(s, ends[i]);
    return {
      text: line,
      parts: line === '' ? [] : [[undefined, line]],
      brk: i + 1 < starts.length ? text.slice(ends[i], starts[i + 1]) : '',
    };
  });
}

/** How many lines two lists share at the start, and then at the end (by text). */
function shared(a: readonly DrawnLine[], b: readonly DrawnLine[]): [head: number, tail: number] {
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head]!.text === b[head]!.text) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail]!.text === b[b.length - 1 - tail]!.text) tail++;
  return [head, tail];
}

/**
 * The input's lines for `value`.
 * - Colours from `drawn`, the text last highlighted: when that is an older text, the lines both
 *   share at the start and at the end keep their colours, the lines between show plain.
 * - Keys from `previous`, the lines shown before: the lines shared at the start and at the end
 *   keep theirs, the changed lines take the replaced lines' keys in order, more lines get new
 *   keys `n<number>`, counted from `fresh` (the result's `fresh` is where the next ones start).
 */
export function editorLines(
  value: string,
  drawn: { text: string; lines: readonly DrawnLine[] } | undefined,
  previous: readonly EditorLine[] | undefined,
  fresh = 0,
): { lines: EditorLine[]; fresh: number } {
  let lines: DrawnLine[];
  if (drawn && drawn.text === value) lines = [...drawn.lines];
  else {
    lines = plainLines(value);
    if (drawn) {
      // The colours only: the line breaks stay the value's (a line may end in CRLF now).
      const [head, tail] = shared(lines, drawn.lines);
      for (let i = 0; i < head; i++) lines[i] = { ...lines[i]!, parts: drawn.lines[i]!.parts };
      for (let i = 1; i <= tail; i++)
        lines[lines.length - i] = { ...lines[lines.length - i]!, parts: drawn.lines[drawn.lines.length - i]!.parts };
    }
  }
  if (!previous) return { lines: lines.map((l, i) => ({ ...l, key: String(i) })), fresh };
  const [head, tail] = shared(lines, previous);
  const middle = previous.length - head - tail;
  let next = fresh;
  const keyed = lines.map((l, i) => {
    const fromEnd = lines.length - 1 - i;
    const key =
      i < head
        ? previous[i]!.key
        : fromEnd < tail
          ? previous[previous.length - 1 - fromEnd]!.key
          : i - head < middle
            ? previous[i]!.key
            : `n${next++}`;
    return { ...l, key };
  });
  return { lines: keyed, fresh: next };
}

interface Shown {
  on: boolean;
  value: string;
  drawn: { text: string; lines: readonly DrawnLine[] } | undefined;
  lines: EditorLine[] | undefined;
  fresh: number;
}

/** The lines to show, keyed from the ones shown at the last render (React's "previous render" state). */
function shownAfter(prev: Shown | undefined, on: boolean, value: string, drawn: Shown['drawn']): Shown {
  if (!on) return { on, value, drawn, lines: undefined, fresh: prev?.fresh ?? 0 };
  const { lines, fresh } = editorLines(value, drawn, prev?.lines, prev?.fresh ?? 0);
  return { on, value, drawn, lines, fresh };
}

type KindStyles = Record<HighlightKind, TextStyle>;

const kindStyles = (c: Palette): KindStyles =>
  Object.fromEntries(
    HIGHLIGHT_KINDS.map((k) => [k, { color: c.highlight[k], ...(k === 'linkUrl' ? { textDecorationLine: 'underline' } : {}) }]),
  ) as KindStyles;

/** One line of the text; re-rendered only when its pieces, its line break or the colours change. */
const Line = memo(
  function Line({ parts, brk, styles }: { parts: readonly Part[]; brk: string; styles: KindStyles }) {
    return (
      <Text>
        {parts.map(([kind, text], i) =>
          kind ? (
            <Text key={i} style={styles[kind]}>
              {text}
            </Text>
          ) : (
            text
          ),
        )}
        {brk}
      </Text>
    );
  },
  (a, b) => a.styles === b.styles && a.brk === b.brk && (a.parts === b.parts || sameParts(a.parts, b.parts)),
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
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const c = usePalette();
  const on = useOutputSettings().highlightEditing && value.length <= HIGHLIGHT_MAX;
  const deferred = useDeferredValue(value);
  const shown = value.length >= DEFER_FROM ? deferred : value;
  const drawn = useMemo(() => (on && shown.length <= HIGHLIGHT_MAX ? { text: shown, lines: drawLines(shown) } : undefined), [on, shown]);
  // The lines shown at the last render, kept to key the new ones; recomputed when the text changes.
  const [last, setLast] = useState(() => shownAfter(undefined, on, value, drawn));
  let now = last;
  if (last.on !== on || last.value !== value || last.drawn !== drawn) {
    now = shownAfter(last, on, value, drawn);
    setLast(now);
  }
  const lines = now.lines;
  const styles = useMemo(() => kindStyles(c), [c]);
  const common = {
    ref: input,
    testID,
    accessibilityLabel,
    onChangeText,
    onSelectionChange: (e: { nativeEvent: { selection: { start: number; end: number } } }) => onSelectionChange(e.nativeEvent.selection),
    ...(selection ? { selection } : {}),
    multiline: true,
    autoCapitalize: 'none',
    autoCorrect: false,
    spellCheck: false,
    textAlignVertical: 'top',
    scrollEnabled: true,
    style,
  } as const;
  // Highlighted: the children are the text (a value next to them is refused on Android).
  if (lines)
    return (
      <TextInput {...common}>
        {lines.map((l) => (
          <Line key={l.key} parts={l.parts} brk={l.brk} styles={styles} />
        ))}
      </TextInput>
    );
  return <TextInput {...common} value={value} />;
}

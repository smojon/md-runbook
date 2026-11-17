import type { Ref } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

export interface TextSelection {
  start: number;
  end: number;
}

export interface RunbookTextInputHandle {
  focus(): void;
}

/** From this many characters, the colours follow typing a moment later. */
export const DEFER_FROM = 50_000;
/** Above this many characters, the text is not highlighted. */
export const HIGHLIGHT_MAX = 500_000;

/**
 * The runbook text field of Edit as Text: a text input on iOS and Android
 * (RunbookTextInput.tsx), a textarea over a highlighted drawing on the web
 * (RunbookTextInput.web.tsx). Both colour the text with editor/highlight.ts, with the same
 * thresholds (DEFER_FROM, HIGHLIGHT_MAX).
 */
export interface RunbookTextInputProps {
  ref?: Ref<RunbookTextInputHandle>;
  testID: string;
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
  /** A selection the screen sets (a problem's line); undefined: the field's own. */
  selection?: TextSelection | undefined;
  onSelectionChange: (selection: TextSelection) => void;
  style: StyleProp<TextStyle>;
}

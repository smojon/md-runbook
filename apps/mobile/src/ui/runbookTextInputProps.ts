import type { Ref } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

export interface TextSelection {
  start: number;
  end: number;
}

export interface RunbookTextInputHandle {
  focus(): void;
}

/**
 * The runbook text field of Edit as Text: a text input on iOS and Android
 * (RunbookTextInput.tsx), a CodeMirror editor on the web (RunbookTextInput.web.tsx).
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

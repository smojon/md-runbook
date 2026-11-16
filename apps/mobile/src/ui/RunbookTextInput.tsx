/** Edit as Text on iOS and Android: the runbook's Markdown in a multiline text input. */
import { useImperativeHandle, useRef } from 'react';
import { TextInput, TextInputInstance } from 'react-native';
import type { RunbookTextInputProps } from './runbookTextInputProps';

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
  return (
    <TextInput
      ref={input}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      value={value}
      onChangeText={onChangeText}
      onSelectionChange={(e) => onSelectionChange(e.nativeEvent.selection)}
      {...(selection ? { selection } : {})}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      textAlignVertical="top"
      scrollEnabled
      style={style}
    />
  );
}

/**
 * VS Code's icons (Codicons, https://github.com/microsoft/vscode-codicons, font licensed under
 * CC BY 4.0 by Microsoft) drawn from their font, so the app's buttons are the editor's.
 */
import { StyleProp, Text, TextStyle } from 'react-native';

export const CODICON_FONT = 'codicon';
export const codiconFont = require('@vscode/codicons/dist/codicon.ttf') as number;

/** The glyphs the app uses (code points from codicon.css of the pinned version). */
const GLYPHS = {
  play: 0xeb2c,
  'debug-stop': 0xead7,
  'run-above': 0xebbd,
  'run-below': 0xebbe,
  'run-all': 0xeb9e,
  check: 0xeab2,
  close: 0xea76,
  error: 0xea87,
  pass: 0xeba4,
  'pass-filled': 0xebb3,
  'circle-large-outline': 0xebb5,
  'circle-slash': 0xeabd,
  loading: 0xeb19,
  warning: 0xea6c,
  'chevron-down': 0xeab4,
  'chevron-right': 0xeab6,
  copy: 0xebcc,
  server: 0xeb50,
  save: 0xeb4b,
  trash: 0xea81,
  'desktop-download': 0xea78,
  'circle-filled': 0xea71,
} as const;

export type CodiconName = keyof typeof GLYPHS;

export function Codicon({
  name,
  size = 16,
  color,
  style,
}: {
  name: CodiconName;
  size?: number;
  color: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      aria-hidden
      selectable={false}
      style={[{ fontFamily: CODICON_FONT, fontSize: size, lineHeight: size + 2, color }, style]}
    >
      {String.fromCodePoint(GLYPHS[name])}
    </Text>
  );
}

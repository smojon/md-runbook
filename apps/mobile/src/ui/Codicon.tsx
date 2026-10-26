/**
 * VS Code's icons (Codicons, https://github.com/microsoft/vscode-codicons, font licensed under
 * CC BY 4.0 by Microsoft) drawn from their font, so the app's buttons are the editor's.
 */
import { useFonts } from 'expo-font';
import { StyleProp, Text, TextStyle, View, ViewStyle } from 'react-native';

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
  'debug-step-over': 0xead6,
  'debug-continue': 0xeacf,
  'debug-pause': 0xead1,
  save: 0xeb4b,
  trash: 0xea81,
  'desktop-download': 0xea78,
  'circle-filled': 0xea71,
  ellipsis: 0xea7c,
  sparkle: 0xec10,
  'settings-gear': 0xeb51,
  add: 0xea60,
  'folder-opened': 0xeaf7,
  link: 0xeb15,
  notebook: 0xebaf,
  'device-camera': 0xeada,
  pin: 0xeb2b,
  pinned: 0xeba0,
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
  // Until the font is in, a blank of the glyph's size: a glyph drawn before would be measured and
  // drawn with a fallback font and not redrawn (iOS showed "?" boxes, Android cut glyphs in half
  // on the start screen, which renders before the font loads).
  const [loaded] = useFonts({ [CODICON_FONT]: codiconFont });
  if (!loaded) return <View style={[{ width: size, height: size + 2 }, style as StyleProp<ViewStyle>]} />;
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

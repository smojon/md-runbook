/**
 * Points: one short idea per line, each after a bullet, in the caller's text style. Help texts,
 * warnings and prompts that say several things use it instead of one long paragraph.
 */
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export function Points({
  items,
  textStyle,
  style,
  testID,
  role,
}: {
  items: readonly string[];
  /** The style of each point's text (and of its bullet). */
  textStyle?: StyleProp<TextStyle>;
  /** The list's own style (margins). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** For a warning read out at once: "alert". */
  role?: 'alert';
}) {
  return (
    <View testID={testID} role={role} style={[styles.points, style]}>
      {items.map((p, i) => (
        <View key={i} style={styles.point}>
          <Text style={textStyle}>{'•'}</Text>
          <Text style={[textStyle, styles.text]}>{p}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  points: { gap: 2 },
  point: { flexDirection: 'row', gap: 8 },
  text: { flex: 1 },
});

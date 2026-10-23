/**
 * The short bar at the top of a bottom sheet: says it's a sheet over the screen, and a tap on it
 * closes the sheet (as a tap on the dimmed screen above it does).
 */
import { Pressable, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function Grabber({ onClose }: { onClose(): void }) {
  const styles = useStyles();
  return (
    <Pressable
      testID="sheet-grabber"
      accessibilityRole="button"
      accessibilityLabel={t.close}
      onPress={onClose}
      style={styles.area}
      hitSlop={8}
    >
      <View style={styles.bar} />
    </Pressable>
  );
}

const useStyles = themedStyles((c) => ({
  area: { alignSelf: 'center', paddingBottom: 10, marginTop: -4 },
  bar: { width: 36, height: 5, borderRadius: 3, backgroundColor: c.placeholder },
}));

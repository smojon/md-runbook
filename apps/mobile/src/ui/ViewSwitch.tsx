/**
 * Runbook | Steps: what a narrow screen (a phone) shows of a runbook, at the top of its screen,
 * under the title. It stays there while the runbook scrolls, so the other one is always one tap
 * away. While the run waits for an answer, Steps has a dot (and says so to a screen reader). It
 * never switches by itself.
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import type { RunbookViewMode } from '../runbooks/viewMode';
import { themedStyles } from '../theme';

export function ViewSwitch({
  value,
  waiting,
  onChange,
}: {
  value: RunbookViewMode;
  waiting: boolean;
  onChange(mode: RunbookViewMode): void;
}) {
  const styles = useStyles();
  const segment = (mode: RunbookViewMode, label: string, a11y: string, dot: boolean) => {
    const on = value === mode;
    return (
      <Pressable
        testID={`view-${mode}`}
        accessibilityRole="tab"
        accessibilityLabel={a11y}
        accessibilityState={{ selected: on }}
        aria-selected={on}
        onPress={() => onChange(mode)}
        style={({ pressed }) => [styles.segment, on && styles.on, pressed && !on && styles.pressed]}
      >
        <Text style={[styles.text, on && styles.textOn]}>{label}</Text>
        {dot ? <View testID={`view-${mode}-dot`} style={styles.dot} /> : null}
      </Pressable>
    );
  };
  return (
    <View testID="view-switch" accessibilityRole="tablist" accessibilityLabel={t.viewSwitch} style={styles.bar}>
      <View style={styles.track}>
        {segment('runbook', t.viewRunbook, t.viewRunbook, false)}
        {segment('steps', t.viewSteps, waiting ? t.viewStepsWaiting : t.viewSteps, waiting)}
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  bar: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6, backgroundColor: c.background },
  // As iOS's segmented control: two halves in a rounded track, the one shown raised.
  track: { flexDirection: 'row', padding: 2, borderRadius: 9, backgroundColor: c.codeBackground },
  segment: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 7,
  },
  on: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  pressed: { opacity: 0.6 },
  text: { fontSize: 14, color: c.muted, fontWeight: '500' },
  textOn: { color: c.text, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.warning },
}));

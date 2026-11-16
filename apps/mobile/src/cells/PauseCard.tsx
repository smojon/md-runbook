/**
 * Pause Before This Step, as VS Code asks it on the cell: Run All stopped before a step marked to
 * pause; Continue runs it and goes on, Stop ends the run there (Resume goes on from it).
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function PauseCard(p: { label: string; onContinue(): void; onStop(): void }) {
  const styles = useStyles();
  return (
    <View testID="pause-card" style={styles.card}>
      <Text testID="pause-title" style={styles.title}>
        {t.pausedBeforeStep(p.label)}
      </Text>
      <View style={styles.actions}>
        <Pressable
          testID="pause-continue"
          accessibilityRole="button"
          accessibilityHint={t.pauseContinueHint}
          onPress={p.onContinue}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t.pauseContinue}</Text>
        </Pressable>
        <Pressable
          testID="pause-stop"
          accessibilityRole="button"
          accessibilityHint={t.pauseStopHint}
          onPress={p.onStop}
          style={styles.secondary}
        >
          <Text style={styles.stop}>{t.pauseStop}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.warning, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  stop: { fontSize: 15, color: c.error },
}));

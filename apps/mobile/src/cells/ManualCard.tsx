/**
 * A step done by hand (an unticked `- [ ]` item) that Run all reached: the run waits under its
 * Markdown cell. Done ticks the box in the runbook and goes on; Skip goes on without ticking it;
 * Stop ends the run there (Continue asks again). `manual-steps: continue` in the front matter
 * turns this off.
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function ManualCard(p: { text: string; onDone(): void; onSkip(): void; onStop(): void }) {
  const styles = useStyles();
  return (
    <View testID="manual-card" style={styles.card}>
      <Text testID="manual-title" accessibilityRole="header" style={styles.title}>
        {t.manualTitle}
      </Text>
      <Text testID="manual-what" style={styles.what}>
        {p.text}
      </Text>
      <Text style={styles.body}>{t.manualBody}</Text>
      <View style={styles.actions}>
        <Pressable testID="manual-done" accessibilityRole="button" onPress={p.onDone} style={styles.button}>
          <Text style={styles.buttonText}>{t.manualDone}</Text>
        </Pressable>
        <Pressable testID="manual-skip" accessibilityRole="button" onPress={p.onSkip} style={styles.secondary}>
          <Text style={styles.link}>{t.manualSkip}</Text>
        </Pressable>
        <Pressable testID="manual-stop" accessibilityRole="button" onPress={p.onStop} style={styles.secondary}>
          <Text style={styles.stop}>{t.manualStop}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.warning, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text, fontWeight: '600' },
  what: { fontSize: 15, color: c.text },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 15, color: c.link },
  stop: { fontSize: 15, color: c.error },
}));

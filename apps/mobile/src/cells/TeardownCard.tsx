/**
 * The teardown offer (core/parts.ts): Run all reached the runbook's teardown steps. Take down
 * runs them; Leave it up leaves them as they are (you may go straight on to the next runbook), and
 * Run all doesn't ask again for this runbook until the app restarts (Continue offers it again).
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function TeardownCard(p: { labels: readonly string[]; onTake(): void; onNotNow(): void }) {
  const styles = useStyles();
  return (
    <View testID="teardown-card" style={styles.card}>
      <Text testID="teardown-title" style={styles.title}>
        {t.teardownTitle}
      </Text>
      <Text testID="teardown-what" style={styles.what} numberOfLines={2}>
        {p.labels.join(', ')}
      </Text>
      <Text style={styles.body}>{t.teardownBody}</Text>
      <View style={styles.actions}>
        <Pressable testID="teardown-take" accessibilityRole="button" onPress={p.onTake} style={styles.button}>
          <Text style={styles.buttonText}>{t.teardownTake}</Text>
        </Pressable>
        <Pressable testID="teardown-not-now" accessibilityRole="button" onPress={p.onNotNow} style={styles.secondary}>
          <Text style={styles.link}>{t.teardownNotNow}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.accent, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text, fontWeight: '600' },
  what: { fontSize: 14, color: c.text },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  link: { fontSize: 15, color: c.link },
}));

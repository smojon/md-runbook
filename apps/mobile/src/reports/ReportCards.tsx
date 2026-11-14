/**
 * Run report questions, as cards at the top of the runbook: before the first report to an address
 * (Allow / Not now / Never), and the notice of a signed runbook that runs only when its run is
 * reported (Run / Don't run: no Never, declining means it doesn't run).
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function ReportConsentCard(p: { text: string; onAllow(): void; onNotNow(): void; onNever(): void }) {
  const styles = useStyles();
  return (
    <View testID="report-consent" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {t.reportConsentTitle}
      </Text>
      <Text style={styles.body}>{p.text}</Text>
      <View style={styles.actions}>
        <Pressable testID="report-allow" accessibilityRole="button" onPress={p.onAllow} style={styles.button}>
          <Text style={styles.buttonText}>{t.reportAllow}</Text>
        </Pressable>
        <Pressable testID="report-not-now" accessibilityRole="button" onPress={p.onNotNow} style={styles.secondary}>
          <Text style={styles.link}>{t.reportNotNow}</Text>
        </Pressable>
        <Pressable testID="report-never" accessibilityRole="button" onPress={p.onNever} style={styles.secondary}>
          <Text style={styles.link}>{t.reportNever}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ReportRequiredCard(p: { text: string; onRun(): void; onDecline(): void }) {
  const styles = useStyles();
  return (
    <View testID="report-required" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {t.reportRequiredTitle}
      </Text>
      <Text style={styles.body}>{p.text}</Text>
      <View style={styles.actions}>
        <Pressable testID="report-required-run" accessibilityRole="button" onPress={p.onRun} style={styles.button}>
          <Text style={styles.buttonText}>{t.reportRequiredRun}</Text>
        </Pressable>
        <Pressable testID="report-required-decline" accessibilityRole="button" onPress={p.onDecline} style={styles.secondary}>
          <Text style={styles.link}>{t.reportRequiredDecline}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text, fontWeight: '600' },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 15, color: c.link },
}));

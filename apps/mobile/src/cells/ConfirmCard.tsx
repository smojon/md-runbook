/**
 * The question before a risky cell runs, as VS Code asks it: the risky command it contains (or
 * just "Run cell N?" for a cell with `confirm`), the account it runs as, and how often it may run
 * (retry=). Nothing runs until Run is pressed.
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function ConfirmCard(p: {
  /** The cell's number in the runbook (1-based, as the extension counts). */
  cell: number;
  /** The risky match, or '' for a cell with `confirm`. */
  match: string;
  runsAs?: string;
  attempts?: number;
  onRun(): void;
  onCancel(): void;
}) {
  const styles = useStyles();
  return (
    <View testID="confirm-card" style={styles.card}>
      <Text testID="confirm-title" style={styles.title}>
        {p.match.trim() === '' ? t.confirmTitle(p.cell) : t.confirmRiskyTitle(p.cell, p.match.trim())}
      </Text>
      {p.runsAs ? <Text style={styles.body}>{t.confirmRunsAs(p.runsAs)}</Text> : null}
      {p.attempts && p.attempts > 1 ? <Text style={styles.body}>{t.confirmRetries(p.attempts)}</Text> : null}
      <View style={styles.actions}>
        <Pressable testID="confirm-run" accessibilityRole="button" onPress={p.onRun} style={styles.button}>
          <Text style={styles.buttonText}>{t.confirmRun}</Text>
        </Pressable>
        <Pressable testID="confirm-cancel" accessibilityRole="button" onPress={p.onCancel} style={styles.secondary}>
          <Text style={styles.link}>{t.trustDecline}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.warning, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  link: { fontSize: 15, color: c.link },
}));

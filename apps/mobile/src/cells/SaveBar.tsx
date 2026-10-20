/**
 * Above a runbook: whether its file has the latest text, and Save (or Download on the web for a
 * runbook opened as a copy). When the file changed elsewhere, a card asks what to keep.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { canDownload } from '../runbooks/files';
import { SaveOutcome, loadFileVersion, saveRunbook } from '../runbooks/save';
import { Runbook, hasUnsavedChanges } from '../runbooks/store';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';

export function SaveBar({ runbook }: { runbook: Runbook }) {
  const styles = useStyles();
  const c = usePalette();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | undefined>();
  const unsaved = hasUnsavedChanges(runbook);
  const save = async (overwrite = false): Promise<void> => {
    setBusy(true);
    setOutcome(await saveRunbook(runbook.id, { overwrite }));
    setBusy(false);
  };

  if (!runbook.origin && !(canDownload && runbook.source === 'file')) {
    return (
      <View style={styles.bar}>
        <Text testID="save-state" style={styles.state}>
          {t.savedInApp}
        </Text>
      </View>
    );
  }
  const conflict = outcome?.kind === 'conflict' ? outcome : undefined;
  return (
    <View>
      <View style={styles.bar}>
        {runbook.origin ? (
          <View style={styles.stateRow}>
            {unsaved ? <Codicon name="circle-filled" size={10} color={c.warning} /> : <Codicon name="check" size={12} color={c.ok} />}
            <Text testID="save-state" style={styles.state}>
              {unsaved ? t.unsaved : t.saved}
            </Text>
          </View>
        ) : (
          <View style={styles.stateRow} />
        )}
        {busy ? <ActivityIndicator size="small" color={c.muted} /> : null}
        <Pressable
          testID="save-runbook"
          accessibilityRole="button"
          disabled={busy || (runbook.origin !== undefined && !unsaved)}
          onPress={() => void save()}
          style={[styles.button, (busy || (runbook.origin !== undefined && !unsaved)) && styles.disabled]}
        >
          <Codicon name={runbook.origin ? 'save' : 'desktop-download'} size={14} color={c.link} />
          <Text style={styles.buttonText}>{runbook.origin ? t.saveToFile : t.download}</Text>
        </Pressable>
      </View>
      {outcome?.kind === 'error' ? (
        <Text testID="save-error" role="alert" style={styles.error}>
          {outcome.message}
        </Text>
      ) : null}
      {conflict ? (
        <View testID="save-conflict" style={styles.card}>
          <Text style={styles.cardTitle}>{t.conflictTitle}</Text>
          <Text style={styles.cardBody}>{t.conflictBody}</Text>
          <View style={styles.cardActions}>
            <Pressable testID="save-overwrite" accessibilityRole="button" onPress={() => void save(true)} style={styles.danger}>
              <Text style={styles.dangerText}>{t.overwrite}</Text>
            </Pressable>
            <Pressable
              testID="save-load-file"
              accessibilityRole="button"
              onPress={() => {
                loadFileVersion(runbook.id, conflict.fileText);
                setOutcome(undefined);
              }}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{t.loadFileVersion}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, minHeight: 32 },
  stateRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  state: { fontSize: 13, color: c.muted },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4 },
  buttonText: { fontSize: 14, color: c.link },
  disabled: { opacity: 0.4 },
  error: { fontSize: 13, color: c.error, marginVertical: 4 },
  card: { borderWidth: 1, borderColor: c.warning, borderRadius: 6, padding: 12, marginVertical: 6, gap: 6 },
  cardTitle: { fontSize: 15, color: c.text },
  cardBody: { fontSize: 13, color: c.muted, lineHeight: 18 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  danger: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4, backgroundColor: c.error },
  dangerText: { fontSize: 14, color: c.onAccent },
}));

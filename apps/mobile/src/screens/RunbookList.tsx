import { Link, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { openRunbookFile } from '../runbooks/openFile';
import { forgetOrigin } from '../runbooks/files';
import { Runbook, hasUnsavedChanges, removeRunbook, useRunbooks } from '../runbooks/store';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';

export function RunbookList() {
  const styles = useStyles();
  const colors = usePalette();
  const core = useMemo(() => checkCore(), []);
  const runbooks = useRunbooks();
  const items = useMemo(
    () => runbooks.map((r) => ({ ...r, cells: parse(r.text).cells.filter((c) => c.kind === 'code').length })),
    [runbooks],
  );
  const [error, setError] = useState<string | undefined>();
  const open = async (): Promise<void> => {
    setError(undefined);
    const r = await openRunbookFile();
    if (r.kind === 'error') setError(r.message);
    if (r.kind === 'opened') router.push({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
  };
  // The list is the screen's root, with automatic insets: on iOS the header is translucent and
  // content placed above the list would sit under it (and taps there would hit the header).
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(r) => r.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.buttons}>
            <Pressable testID="open-runbook" accessibilityRole="button" onPress={() => void open()} style={styles.button}>
              <Text style={styles.buttonText}>{t.openRunbook}</Text>
            </Pressable>
            <Link href={{ pathname: '/hosts', params: {} }} asChild>
              <Pressable testID="hosts" accessibilityRole="link" style={styles.secondary}>
                <Text style={styles.secondaryText}>{t.hosts}</Text>
              </Pressable>
            </Link>
          </View>
          {error ? (
            <Text testID="open-error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => <RunbookRow item={item} />}
      ListFooterComponent={
        <Text testID="core-status" style={[styles.status, { color: core.ok ? colors.ok : colors.error }]}>
          {core.ok ? t.coreOk : t.coreFailed(core.why)}
        </Text>
      }
    />
  );
}

/** A runbook in the list; opened files can be removed from the app (their file stays). */
function RunbookRow({ item }: { item: Runbook & { cells: number } }) {
  const styles = useStyles();
  const colors = usePalette();
  const [confirming, setConfirming] = useState(false);
  const unsaved = hasUnsavedChanges(item);
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Link href={{ pathname: '/runbook/[id]', params: { id: item.id } }} asChild>
          <Pressable testID={`runbook-${item.id}`} accessibilityRole="link" aria-label={item.title} style={styles.rowLink}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.meta}>
              {t.commands(item.cells)}
              {unsaved ? ` · ${t.unsaved}` : ''}
            </Text>
          </Pressable>
        </Link>
        {item.source === 'file' && !confirming ? (
          <Pressable
            testID={`remove-${item.id}`}
            accessibilityRole="button"
            aria-label={t.forget}
            accessibilityLabel={t.forget}
            hitSlop={8}
            onPress={() => setConfirming(true)}
            style={styles.remove}
          >
            <Codicon name="trash" size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      {confirming ? (
        <View style={styles.confirm}>
          <Text style={styles.meta}>{unsaved ? t.forgetUnsaved : t.forgetConfirm}</Text>
          <Pressable
            testID={`remove-${item.id}-confirm`}
            accessibilityRole="button"
            onPress={() => {
              const r = removeRunbook(item.id);
              if (r?.origin) void forgetOrigin(r.origin);
            }}
            style={styles.danger}
          >
            <Text style={styles.dangerText}>{t.forget}</Text>
          </Pressable>
          <Pressable
            testID={`remove-${item.id}-cancel`}
            accessibilityRole="button"
            onPress={() => setConfirming(false)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{t.cancel}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  rowMain: { flexDirection: 'row', alignItems: 'center' },
  rowLink: { flex: 1 },
  remove: { padding: 8 },
  confirm: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 },
  danger: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4, backgroundColor: colors.error },
  dangerText: { fontSize: 14, color: colors.onAccent },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16 },
  header: { paddingVertical: 12 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: colors.accent },
  buttonText: { fontSize: 15, color: colors.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: colors.accent },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 17, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  status: { fontSize: 13, paddingVertical: 16 },
}));

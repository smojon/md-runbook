import { Link, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { openRunbookFile } from '../runbooks/openFile';
import { useRunbooks } from '../runbooks/store';
import { colors } from '../theme';

export function RunbookList() {
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
          <Pressable testID="open-runbook" accessibilityRole="button" onPress={() => void open()} style={styles.button}>
            <Text style={styles.buttonText}>{t.openRunbook}</Text>
          </Pressable>
          {error ? (
            <Text testID="open-error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
        <Link href={{ pathname: '/runbook/[id]', params: { id: item.id } }} asChild>
          <Pressable testID={`runbook-${item.id}`} accessibilityRole="link" aria-label={item.title} style={styles.row}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.meta}>{t.commands(item.cells)}</Text>
          </Pressable>
        </Link>
      )}
      ListFooterComponent={
        <Text testID="core-status" style={[styles.status, { color: core.ok ? colors.ok : colors.error }]}>
          {core.ok ? t.coreOk : t.coreFailed(core.why)}
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16 },
  header: { paddingVertical: 12 },
  button: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: colors.accent },
  buttonText: { fontSize: 15, color: colors.onAccent },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 17, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  status: { fontSize: 13, paddingVertical: 16 },
});

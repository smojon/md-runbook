import { Link } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { BUNDLED } from '../runbooks/sample';
import { colors } from '../theme';

export function RunbookList() {
  const core = useMemo(() => checkCore(), []);
  const items = useMemo(() => BUNDLED.map((r) => ({ ...r, cells: parse(r.text).cells.filter((c) => c.kind === 'code').length })), []);
  // The list is the screen's root, with automatic insets: on iOS the header is translucent and
  // content placed above the list would sit under it (and taps there would hit the header).
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(r) => r.id}
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
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 17, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  status: { fontSize: 13, paddingVertical: 16 },
});

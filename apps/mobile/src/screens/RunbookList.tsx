import { Link } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { BUNDLED } from '../runbooks/sample';
import { colors } from '../theme';

export function RunbookList() {
  const core = useMemo(() => checkCore(), []);
  const items = useMemo(() => BUNDLED.map((r) => ({ ...r, cells: parse(r.text).cells.filter((c) => c.kind === 'code').length })), []);
  return (
    <View style={styles.screen}>
      <Text style={styles.heading} role="heading">
        {t.runbooks}
      </Text>
      <FlatList
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
      />
      <Text testID="core-status" style={[styles.status, { color: core.ok ? colors.ok : colors.error }]}>
        {core.ok ? t.coreOk : t.coreFailed(core.why)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.background },
  heading: { fontSize: 22, fontWeight: '600', marginBottom: 12, color: colors.text },
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 17, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  status: { fontSize: 13, paddingVertical: 8 },
});

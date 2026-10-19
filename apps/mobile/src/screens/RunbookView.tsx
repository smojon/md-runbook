import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ParsedCell, parse } from '@md-runbook/core';
import { t } from '../i18n';
import { BUNDLED } from '../runbooks/sample';
import { colors, mono } from '../theme';

/** Read-only view of a runbook's cells; running them over SSH comes next. */
export function RunbookView({ id }: { id: string | undefined }) {
  const runbook = BUNDLED.find((r) => r.id === id);
  const cells = useMemo(() => (runbook ? parse(runbook.text).cells : []), [runbook]);
  // Scroll views as the screen's root with automatic insets (see RunbookList).
  if (!runbook) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <Text testID="runbook-not-found">{t.notFound}</Text>
      </ScrollView>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: runbook.title }} />
      <FlatList
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={cells}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }) => <Cell cell={item} index={index} />}
      />
    </>
  );
}

function Cell({ cell, index }: { cell: ParsedCell; index: number }) {
  if (cell.kind === 'markup') {
    return (
      <Text testID={`cell-${index}`} style={styles.markup}>
        {cell.value}
      </Text>
    );
  }
  return (
    <View testID={`cell-${index}`} style={styles.code}>
      <Text style={styles.lang}>{cell.languageId}</Text>
      <Text style={styles.source} selectable>
        {cell.value}
      </Text>
      {cell.output ? (
        <View testID={`cell-${index}-output`} style={styles.output}>
          <Text style={styles.lang}>{t.outputExit(cell.output.attrs.exit ?? '?')}</Text>
          <Text style={styles.source} selectable>
            {cell.output.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 12 },
  markup: { fontSize: 15, lineHeight: 21, color: colors.text, marginVertical: 6 },
  code: { backgroundColor: colors.codeBackground, borderRadius: 6, padding: 10, marginVertical: 6 },
  lang: { fontSize: 11, color: colors.muted, marginBottom: 4 },
  source: { fontFamily: mono, fontSize: 13, color: colors.text },
  output: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: 8, paddingTop: 6 },
});

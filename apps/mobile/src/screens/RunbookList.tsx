import { Link, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { openRunbookFile } from '../runbooks/openFile';
import { openRunbookLink } from '../runbooks/openLink';
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
  /** Open a link…: the address being typed (undefined: the field is closed). */
  const [link, setLink] = useState<string | undefined>();
  const openLink = async (): Promise<void> => {
    if (!link) return;
    setError(undefined);
    const r = await openRunbookLink(link);
    if (r.kind === 'error') return setError(r.message);
    setLink(undefined);
    router.push({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
  };
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
          <View style={styles.actions}>
            <Pressable testID="open-runbook" accessibilityRole="button" onPress={() => void open()} style={[styles.action, styles.primary]}>
              <Codicon name="folder-opened" size={22} color={colors.onAccent} />
              <Text style={styles.primaryText}>{t.openRunbook}</Text>
            </Pressable>
            <Link href={{ pathname: '/scan', params: {} }} asChild>
              <Pressable testID="scan-code" accessibilityRole="button" style={StyleSheet.flatten([styles.action, styles.tinted])}>
                <Codicon name="device-camera" size={22} color={colors.link} />
                <Text style={styles.tintedText}>{t.scanCode}</Text>
              </Pressable>
            </Link>
            <Pressable
              testID="open-link"
              accessibilityRole="button"
              aria-expanded={link !== undefined}
              onPress={() => setLink(link === undefined ? '' : undefined)}
              style={[styles.action, styles.tinted]}
            >
              <Codicon name="link" size={22} color={colors.link} />
              <Text style={styles.tintedText}>{t.openLink}</Text>
            </Pressable>
          </View>
          {link !== undefined ? (
            <View style={styles.linkRow}>
              <TextInput
                testID="open-link-url"
                accessibilityLabel={t.openLink}
                style={styles.linkInput}
                value={link}
                onChangeText={setLink}
                placeholder={t.openLinkPlaceholder}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
                onSubmitEditing={() => void openLink()}
              />
              <Pressable
                testID="open-link-go"
                accessibilityRole="button"
                disabled={link.trim() === ''}
                onPress={() => void openLink()}
                style={[styles.go, link.trim() === '' && styles.disabled]}
              >
                <Text style={styles.primaryText}>{t.open}</Text>
              </Pressable>
            </View>
          ) : null}
          {error ? (
            <Text testID="open-error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <Text style={styles.section} role="heading">
            {t.runbooksSection}
          </Text>
        </View>
      }
      renderItem={({ item, index }) => <RunbookRow item={item} first={index === 0} last={index === items.length - 1} />}
      ListFooterComponent={
        core.ok ? undefined : (
          <Text testID="core-error" role="alert" style={[styles.status, { color: colors.error }]}>
            {t.coreFailed(core.why)}
          </Text>
        )
      }
    />
  );
}

/** A runbook in the list; opened files can be removed from the app (their file stays). */
function RunbookRow({ item, first, last }: { item: Runbook & { cells: number }; first: boolean; last: boolean }) {
  const styles = useStyles();
  const colors = usePalette();
  const [confirming, setConfirming] = useState(false);
  const unsaved = hasUnsavedChanges(item);
  return (
    <View style={[styles.row, first && styles.rowFirst, last && styles.rowLast]}>
      <View style={styles.rowMain}>
        <Link href={{ pathname: '/runbook/[id]', params: { id: item.id } }} asChild>
          <Pressable testID={`runbook-${item.id}`} accessibilityRole="link" aria-label={item.title} style={styles.rowLink}>
            <View style={styles.badge}>
              <Codicon name="notebook" size={18} color={colors.link} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {t.commands(item.cells)}
                {` · ${item.source === 'file' ? (item.fileName ?? t.fromFile) : t.example}`}
                {unsaved ? ` · ${t.unsaved}` : ''}
              </Text>
            </View>
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
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  header: { paddingTop: 16 },
  // Three tiles sharing the width (icon over label): they never run off a narrow screen, and a
  // long label wraps to a second line.
  actions: { flexDirection: 'row', gap: 10 },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 76,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 14,
  },
  primary: { backgroundColor: colors.accent },
  primaryText: { fontSize: 14, fontWeight: '600', color: colors.onAccent, textAlign: 'center' },
  tinted: { backgroundColor: colors.accentSoft },
  tintedText: { fontSize: 14, fontWeight: '600', color: colors.link, textAlign: 'center' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  linkInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  go: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.accent },
  disabled: { opacity: 0.5 },
  error: { fontSize: 13, color: colors.error, marginTop: 10 },
  section: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 28,
    marginBottom: 8,
    marginLeft: 4,
  },
  // The runbooks as one card: rows share a surface, separated by hairlines.
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  rowMain: { flexDirection: 'row', alignItems: 'center' },
  rowLink: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  badge: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '500', color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  remove: { padding: 8, marginLeft: 4 },
  confirm: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingBottom: 12 },
  danger: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: colors.error },
  dangerText: { fontSize: 14, color: colors.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: colors.link },
  status: { fontSize: 13, paddingVertical: 16 },
}));

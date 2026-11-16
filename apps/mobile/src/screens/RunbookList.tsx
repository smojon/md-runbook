import { Link, Stack, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { parse } from '@md-runbook/core';
import { checkCore } from '../coreCheck';
import { t } from '../i18n';
import { openRunbookFile } from '../runbooks/openFile';
import { openRunbookLink } from '../runbooks/openLink';
import { forgetOrigin } from '../runbooks/files';
import { refreshLibrary, useLibrary } from '../runbooks/library';
import { Runbook, hasUnsavedChanges, removeRunbook, useRunbooks } from '../runbooks/store';
import { loadSettings, outputSettings, setOutputSetting, useLibraryUrlSetting } from '../settings/store';
import { GetStarted, TourAction } from '../ui/GetStarted';
import { setPinned, usePins } from '../runbooks/pins';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';
import { LibrarySection } from './LibrarySection';
import { NewRunbookSheet } from '../ui/NewRunbookSheet';
import { ActionsSheet, AppAction } from '../ui/ActionsSheet';
import { HomeHeaderButtons } from '../ui/HomeHeader';
import { CHEAT_SHEET_URL } from '../helpLinks';

export function RunbookList() {
  const styles = useStyles();
  const colors = usePalette();
  const core = useMemo(() => checkCore(), []);
  const runbooks = useRunbooks();
  const items = useMemo(
    () => runbooks.map((r) => ({ ...r, cells: parse(r.text).cells.filter((c) => c.kind === 'code').length })),
    [runbooks],
  );
  const pins = usePins();
  const library = useLibrary();
  // The team library: read on start (and when its address changes), again on pull to refresh.
  const libraryUrl = useLibraryUrlSetting();
  useEffect(() => {
    void refreshLibrary();
  }, [libraryUrl]);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = (): void => {
    setRefreshing(true);
    void refreshLibrary({ force: true }).finally(() => setRefreshing(false));
  };
  /**
   * Pinned runbooks first (in the order pinned), then the others, each group a card under its
   * heading. Copies of the team library's runbooks are under Team runbooks, unless the library no
   * longer lists them (or can't be read).
   */
  const rows = useMemo(() => {
    const listed = new Set((library.library?.entries ?? []).map((e) => e.path));
    const inLibrary = (r: Runbook): boolean => r.source === 'library' && r.library?.base === library.base && listed.has(r.library.path);
    const pinned = pins.flatMap((id) => items.filter((i) => i.id === id));
    const rest = items.filter((i) => !pins.includes(i.id) && !inLibrary(i));
    const out: ListRow[] = [];
    const group = (title: string, list: typeof items, isPinned: boolean): void => {
      if (list.length === 0) return;
      out.push({ kind: 'heading', key: 'h-' + title, title });
      list.forEach((r, i) =>
        out.push({ kind: 'runbook', key: r.id, item: r, first: i === 0, last: i === list.length - 1, pinned: isPinned }),
      );
    };
    group(t.pinnedSection, pinned, true);
    group(t.runbooksSection, rest, false);
    return out;
  }, [items, pins, library]);
  const [error, setError] = useState<string | undefined>();
  /** New runbook…: its sheet (a file name, blank or from the template). */
  const [creating, setCreating] = useState(false);
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
  /** The start screen's ⋯ (header): its actions and the help, each also on the screen or the gear. */
  const [menu, setMenu] = useState(false);
  /** Get Started: by itself until skipped or done once (the settings say, once read), and from ⋯. */
  const [tour, setTour] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSettings().then(() => live && !outputSettings().tourSeen && setTour(true));
    return () => {
      live = false;
    };
  }, []);
  const list = useRef<FlatList<ListRow>>(null);
  /** Asked for from ⋯ (a count, so each time): scrolled into sight, after the runbooks. */
  const [tourAsked, setTourAsked] = useState(0);
  useEffect(() => {
    if (tourAsked === 0) return;
    const timer = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [tourAsked]);
  const closeTour = (): void => {
    setTour(false);
    setOutputSetting('tourSeen', true);
  };
  const tourAction = (a: TourAction): void => {
    if (a === 'sample') router.push({ pathname: '/runbook/[id]', params: { id: 'sample' } });
    else router.push('/hosts');
  };
  const action = (id: keyof typeof t.actions, group: AppAction['group'], run: () => void): AppAction => ({
    id,
    title: t.actions[id][0],
    hint: t.actions[id][1],
    group,
    run,
  });
  const homeActions: AppAction[] = [
    action('openFile', 'open', () => void open()),
    action('scanCode', 'open', () => router.push('/scan')),
    action('openLink', 'open', () => setLink('')),
    action('newRunbook', 'edit', () => setCreating(true)),
    action('getStarted', 'help', () => {
      setTour(true);
      setTourAsked((n) => n + 1);
    }),
    action('sample', 'help', () => router.push({ pathname: '/runbook/[id]', params: { id: 'sample' } })),
    action('cheatSheet', 'help', () => void Linking.openURL(CHEAT_SHEET_URL)),
    action('hosts', 'help', () => router.push('/hosts')),
  ];
  // The list is the screen's root, with automatic insets: on iOS the header is translucent and
  // content placed above the list would sit under it (and taps there would hit the header).
  return (
    <FlatList
      ref={list}
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={(r) => r.key}
      refreshing={refreshing}
      onRefresh={onRefresh}
      ListHeaderComponent={
        <View style={styles.header}>
          <Stack.Screen options={{ headerRight: () => <HomeHeaderButtons onMore={() => setMenu(true)} /> }} />
          <ActionsSheet actions={homeActions} visible={menu} onClose={() => setMenu(false)} />
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
            <Pressable
              testID="new-runbook"
              accessibilityRole="button"
              onPress={() => setCreating(true)}
              style={[styles.action, styles.tinted]}
            >
              <Codicon name="new-file" size={22} color={colors.link} />
              <Text style={styles.tintedText}>{t.newRunbook}</Text>
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
          <NewRunbookSheet visible={creating} onClose={() => setCreating(false)} />
        </View>
      }
      renderItem={({ item }) =>
        item.kind === 'heading' ? (
          <Text style={styles.section} role="heading">
            {item.title}
          </Text>
        ) : (
          <RunbookRow item={item.item} first={item.first} last={item.last} pinned={item.pinned} />
        )
      }
      ListFooterComponent={
        <>
          {tour ? <GetStarted onAction={tourAction} onClose={closeTour} /> : null}
          <LibrarySection />
          {core.ok ? null : (
            <Text testID="core-error" role="alert" style={[styles.status, { color: colors.error }]}>
              {t.coreFailed(core.why)}
            </Text>
          )}
        </>
      }
    />
  );
}

/** A runbook in the list; opened files can be removed from the app (their file stays). */
type ListRow =
  | { kind: 'heading'; key: string; title: string }
  | { kind: 'runbook'; key: string; item: Runbook & { cells: number }; first: boolean; last: boolean; pinned: boolean };

function RunbookRow({ item, first, last, pinned }: { item: Runbook & { cells: number }; first: boolean; last: boolean; pinned: boolean }) {
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
                {` · ${item.source === 'bundled' ? t.example : item.source === 'library' ? t.fromLibrary(item.fileName ?? item.title) : (item.fileName ?? t.fromFile)}`}
                {unsaved ? ` · ${t.unsaved}` : ''}
              </Text>
            </View>
          </Pressable>
        </Link>
        {!confirming ? (
          <Pressable
            testID={`pin-${item.id}`}
            accessibilityRole="button"
            aria-label={pinned ? t.unpin : t.pin}
            accessibilityLabel={pinned ? t.unpin : t.pin}
            accessibilityState={{ selected: pinned }}
            hitSlop={8}
            onPress={() => setPinned(item.id, !pinned)}
            style={styles.remove}
          >
            <Codicon name={pinned ? 'pinned' : 'pin'} size={16} color={pinned ? colors.link : colors.muted} />
          </Pressable>
        ) : null}
        {item.source !== 'bundled' && !confirming ? (
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
              setPinned(item.id, false);
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

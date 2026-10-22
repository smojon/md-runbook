/**
 * Every action of a screen in one place, for both kinds of user: browse it by group (Run, Values,
 * Assistant, Share, Help, as in the extension's toolbar), or type to find one (as Ctrl+Shift+P in
 * VS Code; Ctrl/⌘+K opens it with a keyboard). Each action says when it matters.
 */
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles, usePalette } from '../theme';

export interface AppAction {
  id: string;
  /** The same title as the extension's command, where there is one. */
  title: string;
  /** When it matters to you (as in the cheat sheet). */
  hint: string;
  group: ActionGroup;
  run(): void;
  /** Shown but not available now, with why. */
  disabled?: string;
}

export type ActionGroup = 'run' | 'steps' | 'values' | 'assistant' | 'share' | 'help';
const GROUPS: readonly ActionGroup[] = ['run', 'steps', 'values', 'assistant', 'share', 'help'];

/** Actions whose title, hint or group contain every word of `query`, case-insensitively. */
export function matchActions(actions: readonly AppAction[], query: string): AppAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return actions.filter((a) => {
    const text = `${a.title} ${a.hint} ${t.actionGroups[a.group]}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function ActionsSheet({ actions, visible, onClose }: { actions: readonly AppAction[]; visible: boolean; onClose(): void }) {
  const styles = useStyles();
  const colors = usePalette();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => matchActions(actions, query), [actions, query]);
  const pick = (a: AppAction): void => {
    if (a.disabled) return;
    setQuery('');
    onClose();
    a.run();
  };
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.close} />
      <View testID="actions-sheet" style={styles.sheet}>
        <TextInput
          testID="actions-search"
          accessibilityLabel={t.searchActions}
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t.searchActions}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={() => {
            const first = shown.find((a) => !a.disabled);
            if (first) pick(first);
          }}
        />
        <ScrollView keyboardShouldPersistTaps="handled">
          {GROUPS.map((g) => {
            const items = shown.filter((a) => a.group === g);
            if (items.length === 0) return null;
            return (
              <View key={g} style={styles.group}>
                <Text style={styles.groupTitle}>{t.actionGroups[g]}</Text>
                {items.map((a) => (
                  <Pressable
                    key={a.id}
                    testID={`action-${a.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !!a.disabled }}
                    onPress={() => pick(a)}
                    style={({ pressed }) => [styles.item, pressed && styles.pressed, a.disabled !== undefined && styles.disabled]}
                  >
                    <Text style={styles.title}>{a.title}</Text>
                    <Text style={styles.hint}>{a.disabled ?? a.hint}</Text>
                  </Pressable>
                ))}
              </View>
            );
          })}
          {shown.length === 0 ? <Text style={styles.hint}>{t.noActions(query)}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: c.background,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 14,
    paddingBottom: 28,
  },
  search: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 16,
    color: c.text,
    marginBottom: 8,
  },
  group: { marginTop: 10 },
  groupTitle: { fontSize: 12, fontWeight: '600', color: c.muted, textTransform: 'uppercase', marginBottom: 4 },
  item: { paddingVertical: 9, paddingHorizontal: 6, borderRadius: 6 },
  pressed: { backgroundColor: c.codeBackground },
  disabled: { opacity: 0.45 },
  title: { fontSize: 16, color: c.text },
  hint: { fontSize: 13, color: c.muted, marginTop: 2, lineHeight: 18 },
}));

/**
 * A Markdown cell with its notes for the record (Add Note) each under a ⋯: Edit Note (its words,
 * in place; the time, author and milestone stay) and Delete Note (after a confirm). The rest of
 * the cell is drawn as before. The text itself changes through `onChangeNote`.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { MarkdownView, countTaskBoxes } from '../markdown/MarkdownView';
import { NoteBlock, NotePart, noteParts } from '../runbooks/notes';
import { themedStyles, usePalette } from '../theme';
import { ActionsSheet, AppAction } from '../ui/ActionsSheet';
import { Codicon } from '../ui/Codicon';
import { confirmThen } from '../ui/confirm';

export interface NotedMarkdownProps {
  markdown: string;
  testID: string;
  firstTask?: number;
  onToggleTask?(index: number): void;
  /** A note's new words, or undefined to delete it (found by its marker). */
  onChangeNote?(marker: string, words: string | undefined): void;
}

/** Each part with the task boxes before it (box k there is item firstTask + tasks + k) and its note's number. */
function layParts(markdown: string): (NotePart & { tasks: number; n: number })[] {
  const out: (NotePart & { tasks: number; n: number })[] = [];
  let tasks = 0;
  let notes = 0;
  for (const p of noteParts(markdown)) {
    out.push({ ...p, tasks, n: p.kind === 'note' ? notes++ : -1 });
    tasks += countTaskBoxes(p.markdown);
  }
  return out;
}

export function NotedMarkdown({ markdown, testID, firstTask = 0, onToggleTask, onChangeNote }: NotedMarkdownProps) {
  const styles = useStyles();
  const colors = usePalette();
  const parts = useMemo(() => layParts(markdown), [markdown]);
  const [sheet, setSheet] = useState<NoteBlock | undefined>();
  const [editing, setEditing] = useState<{ marker: string; words: string } | undefined>();
  if (!onChangeNote || !parts.some((p) => p.kind === 'note')) {
    return <MarkdownView testID={testID} markdown={markdown} firstTask={firstTask} onToggleTask={onToggleTask} />;
  }
  const actions: AppAction[] = sheet
    ? [
        {
          id: 'editNote',
          title: t.actions.editNote[0],
          hint: t.actions.editNote[1],
          group: 'run',
          run: () => setEditing({ marker: sheet.marker, words: sheet.text }),
        },
        {
          id: 'deleteNote',
          title: t.actions.deleteNote[0],
          hint: t.actions.deleteNote[1],
          group: 'run',
          run: () => {
            const marker = sheet.marker;
            confirmThen(t.deleteNoteConfirm, t.deleteNotePoints, t.deleteNoteButton, () => onChangeNote(marker, undefined));
          },
        },
      ]
    : [];
  return (
    <View testID={testID}>
      {parts.map((p, i) => {
        const first = firstTask + p.tasks;
        if (p.kind === 'markdown') return <MarkdownView key={i} markdown={p.markdown} firstTask={first} onToggleTask={onToggleTask} />;
        const id = `${testID}-note-${p.n}`;
        if (editing?.marker === p.note.marker) {
          const empty = editing.words.trim() === '';
          return (
            <View key={i} testID={`${id}-editor`} style={styles.editor}>
              <Text style={styles.title}>{t.editNoteTitle}</Text>
              {p.note.head ? <Text style={styles.head}>{p.note.head.replace(/^\*\*|:\*\*$/g, '')}</Text> : null}
              <TextInput
                testID={`${id}-text`}
                accessibilityLabel={t.editNoteTitle}
                value={editing.words}
                onChangeText={(words) => setEditing({ ...editing, words })}
                multiline
                autoFocus
                placeholderTextColor={colors.placeholder}
                style={styles.input}
              />
              <View style={styles.buttons}>
                <Pressable
                  testID={`${id}-cancel`}
                  accessibilityRole="button"
                  onPress={() => setEditing(undefined)}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryText}>{t.cancel}</Text>
                </Pressable>
                <Pressable
                  testID={`${id}-save`}
                  accessibilityRole="button"
                  disabled={empty}
                  onPress={() => {
                    setEditing(undefined);
                    onChangeNote(editing.marker, editing.words.trim());
                  }}
                  style={[styles.primary, empty && styles.disabled]}
                >
                  <Text style={styles.primaryText}>{t.editNoteSave}</Text>
                </Pressable>
              </View>
            </View>
          );
        }
        return (
          <View key={i} testID={id} style={styles.note}>
            <View style={styles.noteText}>
              <MarkdownView markdown={p.markdown} firstTask={first} onToggleTask={onToggleTask} />
            </View>
            <Pressable
              testID={`${id}-actions`}
              accessibilityRole="button"
              accessibilityLabel={t.noteActions}
              hitSlop={8}
              onPress={() => setSheet(p.note)}
              style={styles.more}
            >
              <Codicon name="ellipsis" size={16} color={colors.link} />
            </Pressable>
          </View>
        );
      })}
      <ActionsSheet actions={actions} visible={sheet !== undefined} onClose={() => setSheet(undefined)} />
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  note: { flexDirection: 'row', alignItems: 'flex-start' },
  noteText: { flex: 1 },
  // A 44-point target around a small glyph, as the platforms ask.
  more: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  editor: {
    marginVertical: 6,
    padding: 12,
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: { fontSize: 15, fontWeight: '600', color: colors.text },
  head: { fontSize: 13, color: colors.muted },
  input: {
    minHeight: 88,
    textAlignVertical: 'top',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.background,
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12 },
  primary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.accent },
  primaryText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  secondaryText: { fontSize: 15, color: colors.link },
  disabled: { opacity: 0.5 },
}));

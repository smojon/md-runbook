/**
 * A runbook as text, in a screen of its own, as VS Code opens one as text, as a preview or as a
 * runbook. Edit: the Markdown in a monospace field, highlighted (ui/RunbookTextInput; on iOS and Android a setting;
 * Save, Undo, Discard; the lint problems under it, a tap goes to the line). Preview: the Markdown
 * drawn, without Run buttons. Runbook: back to the runbook screen. Unsaved text is kept while the app runs. Saving warns when a signature that
 * matches would no longer match; a runbook's outputs are part of its text and stay.
 */
import { Stack, router } from 'expo-router';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { MarkdownView } from '../markdown/MarkdownView';
import { draftOf, hasOutputs, keepDraft, signatureBreaks } from '../runbooks/editing';
import { runbookProblems } from '../runbooks/lint';
import { updateRunbookText, useRunbooks, withoutFrontMatter } from '../runbooks/store';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';
import { confirmThen } from '../ui/confirm';
import { Points } from '../ui/Points';
import { RunbookTextInput } from '../ui/RunbookTextInput';
import type { RunbookTextInputHandle } from '../ui/runbookTextInputProps';

type Mode = 'edit' | 'preview';
/** Snapshots for Undo: one per pause in typing, at most this many. */
const UNDO_MAX = 200;
const UNDO_PAUSE_MS = 800;

/** The offset where 0-based `line` starts in `text`. */
export function lineOffset(text: string, line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

export function RunbookEditor({ id, from }: { id: string | undefined; from?: string }) {
  const styles = useStyles();
  const colors = usePalette();
  const runbook = useRunbooks().find((r) => r.id === id);
  const [mode, setMode] = useState<Mode>('edit');
  /** The text the draft started from (the runbook as saved then). */
  const [base, setBase] = useState(runbook?.text ?? '');
  const [draft, setDraftState] = useState(() => (id ? draftOf(id) : undefined) ?? runbook?.text ?? '');
  const [undo, setUndo] = useState<{ stack: readonly string[]; at: number }>({ stack: [], at: 0 });
  const [said, setSaid] = useState<string | undefined>();
  const [leaving, setLeaving] = useState(false);
  /** A selection the screen sets (a problem's line); the field's own after that. */
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>();
  const input = useRef<RunbookTextInputHandle>(null);
  const dirty = draft !== base;
  // Not editing: the editor follows the runbook (a run wrote its outputs meanwhile).
  if (runbook && !dirty && runbook.text !== base) {
    setBase(runbook.text);
    setDraftState(runbook.text);
  }
  const checked = useDeferredValue(draft);
  const problems = useMemo(() => runbookProblems(checked).all, [checked]);

  if (!runbook || !id) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t.editorTitle }} />
        <Text style={styles.note}>{t.notFound}</Text>
      </View>
    );
  }

  const setDraft = (next: string, now = Date.now()): void => {
    if (next === draft) return;
    // A snapshot of the text before each burst of typing.
    if (undo.stack.length === 0 || now - undo.at > UNDO_PAUSE_MS) setUndo({ stack: [...undo.stack, draft].slice(-UNDO_MAX), at: now });
    else setUndo({ ...undo, at: now });
    setDraftState(next);
    setSaid(undefined);
    keepDraft(id, next === base ? undefined : next);
  };
  const undoLast = (): void => {
    const prev = undo.stack[undo.stack.length - 1];
    if (prev === undefined) return;
    setUndo({ stack: undo.stack.slice(0, -1), at: 0 });
    setDraftState(prev);
    keepDraft(id, prev === base ? undefined : prev);
  };
  const discard = (): void =>
    confirmThen(t.editorDiscardTitle, t.editorDiscardPoints, t.editorDiscard, () => {
      setDraftState(base);
      setUndo({ stack: [], at: 0 });
      keepDraft(id, undefined);
    });
  const openRunbook = (): void => {
    setLeaving(false);
    if (from === 'runbook' && router.canGoBack?.()) router.back();
    else router.replace({ pathname: '/runbook/[id]', params: { id } });
  };
  /** Save, after a confirm when a signature would break or the runbook changed meanwhile. */
  const save = (then?: () => void): void => {
    const breaks = signatureBreaks(runbook.text, draft);
    const changed = runbook.text !== base;
    const go = (): void => {
      updateRunbookText(id, draft);
      keepDraft(id, undefined);
      setBase(draft);
      setUndo({ stack: [], at: 0 });
      setSaid(t.editorSaved);
      then?.();
    };
    if (!breaks && !changed) return go();
    const points = [
      ...(breaks ? t.editorSignaturePoints(breaks.signer, breaks.name, breaks.version) : []),
      ...(changed ? t.editorChangedPoints : []),
    ];
    confirmThen(breaks ? t.editorSignatureTitle : t.editorChangedTitle, points, t.editorSave, go);
  };
  const goToLine = (line: number): void => {
    const at = lineOffset(draft, line);
    setMode('edit');
    setForced({ start: at, end: at });
    input.current?.focus();
  };

  const copyNote = runbook.source === 'library' ? t.editorLibraryCopy : runbook.link ? t.editorLinkCopy : undefined;
  const segment = (value: Mode | 'runbook', label: string) => {
    const on = value === mode;
    return (
      <Pressable
        key={value}
        testID={`editor-mode-${value}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        aria-selected={on}
        onPress={() => (value === 'runbook' ? (dirty ? setLeaving(true) : openRunbook()) : setMode(value))}
        style={({ pressed }) => [styles.segment, on && styles.segmentOn, pressed && !on && styles.pressed]}
      >
        <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{label}</Text>
      </Pressable>
    );
  };
  const button = (
    testID: string,
    icon: 'save' | 'discard' | 'close',
    label: string,
    onPress: () => void,
    enabled: boolean,
    primary = false,
  ) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [primary ? styles.primary : styles.tool, !enabled && styles.disabled, pressed && styles.pressed]}
    >
      <Codicon name={icon} size={16} color={primary ? colors.onAccent : colors.link} />
      <Text style={primary ? styles.primaryText : styles.toolText}>{label}</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
      <Stack.Screen options={{ title: runbook.title }} />
      <View testID="editor-modes" accessibilityRole="tablist" accessibilityLabel={t.editorModesLabel} style={styles.track}>
        {segment('edit', t.editorModes.edit)}
        {segment('preview', t.editorModes.preview)}
        {segment('runbook', t.editorModes.runbook)}
      </View>
      {leaving ? (
        <View testID="editor-leave" style={styles.card}>
          <Text style={styles.cardTitle}>{t.editorLeaveTitle}</Text>
          <Points items={t.editorLeavePoints} textStyle={styles.note} />
          <View style={styles.cardButtons}>
            <Pressable testID="editor-leave-cancel" accessibilityRole="button" onPress={() => setLeaving(false)} style={styles.plain}>
              <Text style={styles.link}>{t.cancel}</Text>
            </Pressable>
            <Pressable testID="editor-leave-unsaved" accessibilityRole="button" onPress={openRunbook} style={styles.plain}>
              <Text style={styles.link}>{t.editorOpenUnsaved}</Text>
            </Pressable>
            <Pressable testID="editor-leave-save" accessibilityRole="button" onPress={() => save(openRunbook)} style={styles.primary}>
              <Text style={styles.primaryText}>{t.editorSaveAndOpen}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.toolbar}>
        {button('editor-undo', 'discard', t.editorUndo, undoLast, undo.stack.length > 0)}
        {button('editor-discard', 'close', t.editorDiscard, discard, dirty)}
        <View style={styles.grow} />
        <Text testID="editor-state" style={styles.state} role="status">
          {dirty ? t.editorUnsaved : (said ?? '')}
        </Text>
        {button('editor-save', 'save', t.editorSave, () => save(), dirty, true)}
      </View>
      {copyNote || hasOutputs(draft) ? (
        <Points
          testID="editor-notes"
          items={[...(copyNote ? [copyNote] : []), ...(hasOutputs(draft) ? [t.editorOutputs] : [])]}
          textStyle={styles.note}
          style={styles.notes}
        />
      ) : null}
      {mode === 'edit' ? (
        <>
          <RunbookTextInput
            ref={input}
            testID="editor-text"
            accessibilityLabel={t.editorText}
            value={draft}
            onChangeText={(v) => setDraft(v)}
            onSelectionChange={() => setForced(undefined)}
            selection={forced}
            style={styles.text}
          />
          <View testID="editor-problems" style={styles.problems}>
            {problems.length === 0 ? (
              <Text style={styles.note}>{t.editorNoProblems}</Text>
            ) : (
              <ScrollView style={styles.problemList} keyboardShouldPersistTaps="handled">
                <Text style={styles.problemsTitle}>{t.editorProblems(problems.length)}</Text>
                {problems.map((p, i) => (
                  <Pressable
                    key={i}
                    testID={`editor-problem-${i}`}
                    accessibilityRole="button"
                    onPress={() => goToLine(p.line)}
                    style={({ pressed }) => [styles.problem, pressed && styles.pressed]}
                  >
                    <Codicon
                      name={p.severity === 'error' ? 'error' : 'warning'}
                      size={14}
                      color={p.severity === 'error' ? colors.error : colors.warning}
                    />
                    <Text style={styles.problemText}>{t.editorProblemLine(p.line + 1, p.message)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </>
      ) : (
        <ScrollView testID="editor-preview" style={styles.preview} contentContainerStyle={styles.previewContent}>
          {draft.trim() === '' ? (
            <Text style={styles.note}>{t.editorPreviewEmpty}</Text>
          ) : (
            <MarkdownView markdown={withoutFrontMatter(draft)} />
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  // As the Runbook | Steps switch (ui/ViewSwitch.tsx).
  track: { flexDirection: 'row', margin: 12, marginBottom: 6, padding: 2, borderRadius: 9, backgroundColor: c.codeBackground },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  segmentOn: {
    backgroundColor: c.background,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { fontSize: 14, color: c.muted },
  segmentTextOn: { color: c.text, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  grow: { flex: 1 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 10, borderRadius: 8 },
  toolText: { fontSize: 15, color: c.link },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accent,
  },
  primaryText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  disabled: { opacity: 0.4 },
  state: { fontSize: 13, color: c.muted },
  notes: { paddingHorizontal: 12, gap: 2 },
  note: { fontSize: 13, color: c.muted, lineHeight: 18 },
  text: {
    flex: 1,
    marginHorizontal: 12,
    marginTop: 6,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    borderRadius: 8,
    backgroundColor: c.codeBackground,
    color: c.text,
    fontFamily: mono,
    fontSize: 14,
    lineHeight: 20,
  },
  problems: { paddingHorizontal: 12, paddingVertical: 8 },
  problemList: { maxHeight: 132 },
  problemsTitle: { fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 2 },
  problem: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  problemText: { flex: 1, fontSize: 13, color: c.text },
  preview: { flex: 1 },
  previewContent: { padding: 16 },
  card: {
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 12,
    gap: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: c.text },
  cardButtons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  plain: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 15, color: c.link },
}));

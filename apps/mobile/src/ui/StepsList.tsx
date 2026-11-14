/**
 * The runbook's steps by name (runbooks/steps.ts), as VS Code's Steps view: chapters as headings,
 * each step with its state as a symbol and a colour (✓ done, ✕ failed, ▶ running, a pause icon
 * waiting for you, ○ to do), its number, its name, its time, what it will need, and for a failed
 * step the last line of its error. A tap on a row goes to its cell; a long press opens the
 * step's actions (Run, Run from Here, Mark Done…); a checklist item has a tick box. The row the
 * run waits at shows the question's answers as buttons (Done / Skip / Stop, …). The rows of the
 * cells on screen are shaded; the list keeps the running (or waiting) step in view.
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, ScrollViewInstance, Text, View } from 'react-native';
import { t } from '../i18n';
import { needText } from '../runbooks/steps';
import type { StepRowState, StepsRow } from '../runbooks/steps';
import { Palette, themedStyles, usePalette } from '../theme';
import { Codicon } from './Codicon';
import { usePulse } from './motion';
import { TimeBar } from './TimeBar';

const GLYPH: Record<StepRowState, string> = { done: '✓', failed: '✕', running: '▶', waiting: '', pending: '○' };

function glyphColor(c: Palette, s: StepRowState): string {
  return s === 'done' ? c.ok : s === 'failed' ? c.error : s === 'running' ? c.accent : s === 'waiting' ? c.warningText : c.muted;
}

/** A button of the question the run waits at, on its row (the same as on the card under the cell). */
export interface StepAnswer {
  /** In the button's testID: `steps-answer-<row key>-<id>`. */
  id: string;
  label: string;
  /** The first answer is the main one; `stop` is red. */
  kind?: 'primary' | 'secondary' | 'stop';
  hint?: string;
  onPress(): void;
}

export interface StepsAnswers {
  /** The question in a few words (`Done by hand? Tell the team`). */
  question?: string;
  buttons: readonly StepAnswer[];
}

export function StepsList({
  rows,
  visible,
  answers,
  onGo,
  onActions,
  onTick,
}: {
  rows: readonly StepsRow[];
  /** The cells on screen, first and last: their rows are shaded. */
  visible?: { first: number; last: number };
  /** The question the run waits at: on the row that waits. */
  answers?: StepsAnswers;
  onGo(index: number): void;
  /** A long press on a code step's row: its actions. */
  onActions?(index: number): void;
  /** A checklist item's tick box (`item`: its place in its cell). */
  onTick?(index: number, item: number, checked: boolean): void;
}) {
  const styles = useStyles();
  const c = usePalette();
  const pulse = usePulse(rows.some((r) => r.kind === 'step' && r.state === 'running'));
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef(new Map<string, number>());
  // The step to keep in view: the one waiting for you or running, else the first failed, else the next to do.
  const steps = rows.filter((r): r is Extract<StepsRow, { kind: 'step' }> => r.kind === 'step');
  const current =
    steps.find((r) => r.state === 'waiting') ??
    steps.find((r) => r.state === 'running') ??
    steps.find((r) => r.state === 'failed') ??
    steps.find((r) => r.state === 'pending');
  const currentKey = current?.key;
  const scrollToCurrent = (key: string | undefined): void => {
    const y = key !== undefined ? offsets.current.get(key) : undefined;
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 96), animated: true });
  };
  useEffect(() => scrollToCurrent(currentKey), [currentKey]);

  return (
    <ScrollView ref={scroll} testID="steps-list" accessibilityLabel={t.stepsListLabel} contentContainerStyle={styles.list}>
      {rows.map((r) => {
        const seen = visible !== undefined && r.index >= visible.first && r.index <= visible.last;
        const remember = (y: number): void => {
          offsets.current.set(r.key, y);
          if (r.key === currentKey) scrollToCurrent(r.key);
        };
        if (r.kind === 'chapter') {
          return (
            <Pressable
              key={r.key}
              testID={`steps-${r.key}`}
              accessibilityRole="button"
              accessibilityLabel={t.stepsChapter(r.title)}
              onPress={() => onGo(r.index)}
              onLayout={(e) => remember(e.nativeEvent.layout.y)}
              style={({ pressed }) => [styles.chapter, seen && styles.seen, pressed && styles.pressed]}
            >
              <Text style={[styles.chapterText, r.level === 1 && styles.chapterTop]} numberOfLines={2}>
                {r.title}
              </Text>
            </Pressable>
          );
        }
        const active = r.state === 'running' || r.state === 'waiting';
        const needs = r.needs?.map(needText).join(', ');
        const checklist = r.item !== undefined;
        const actions = !checklist && onActions ? () => onActions(r.index) : undefined;
        const asked = r.state === 'waiting' ? answers : undefined;
        const checked = r.state === 'done';
        const label =
          t.stepsRowLabel(r.step, r.label, t.stepsState[r.state], r.time) +
          (needs ? '. ' + t.stepsNeeds(needs) : '') +
          (r.error ? '. ' + t.stepsError(r.error) : '');
        // The row's own buttons (the tick box, the answers) are beside its pressable part, not in
        // it: a screen reader reaches each of them.
        return (
          <View key={r.key} onLayout={(e) => remember(e.nativeEvent.layout.y)} style={[styles.row, seen && styles.seen]}>
            <View style={styles.top}>
              <Pressable
                testID={`steps-row-${r.key}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={actions ? t.stepsRowActionsHint : t.stepsRowHint}
                accessibilityState={{ selected: active }}
                {...(actions
                  ? {
                      onLongPress: actions,
                      accessibilityActions: [{ name: 'activate' }, { name: 'longpress', label: t.stepsActions }],
                      onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
                        if (e.nativeEvent.actionName === 'longpress') actions();
                        else onGo(r.index);
                      },
                    }
                  : {})}
                onPress={() => onGo(r.index)}
                style={({ pressed }) => [styles.main, pressed && styles.pressed]}
              >
                <View style={styles.line}>
                  {r.state === 'waiting' ? (
                    // The pause icon, not a ❚❚ text glyph: some fonts (web) drew that as one tall bar.
                    <View testID={`steps-state-${r.key}`} style={styles.glyphBox}>
                      <Codicon name="debug-pause" size={14} color={glyphColor(c, r.state)} />
                    </View>
                  ) : (
                    <Animated.Text
                      testID={`steps-state-${r.key}`}
                      style={[styles.glyph, { color: glyphColor(c, r.state) }, r.state === 'running' && { opacity: pulse }]}
                    >
                      {GLYPH[r.state]}
                    </Animated.Text>
                  )}
                  <Text style={styles.num}>{r.step !== undefined ? String(r.step) : '·'}</Text>
                  <Text style={[styles.label, active && styles.labelActive, r.state === 'waiting' && styles.waiting]} numberOfLines={2}>
                    {r.label}
                  </Text>
                  {r.time ? (
                    <Text testID={`steps-time-${r.key}`} style={[styles.time, r.over && styles.over]} numberOfLines={1}>
                      {r.time}
                    </Text>
                  ) : null}
                </View>
                {needs ? (
                  <Text testID={`steps-needs-${r.key}`} style={styles.needs} numberOfLines={2}>
                    {t.stepsNeeds(needs)}
                  </Text>
                ) : null}
                {r.error ? (
                  <Text testID={`steps-error-${r.key}`} style={styles.error} numberOfLines={2}>
                    {r.error}
                  </Text>
                ) : null}
                {r.fraction !== undefined ? (
                  <View style={styles.bar}>
                    <TimeBar fraction={r.fraction} over={r.over === true} />
                  </View>
                ) : null}
              </Pressable>
              {checklist && onTick ? (
                <Pressable
                  testID={`steps-tick-${r.key}`}
                  accessibilityRole="checkbox"
                  accessibilityLabel={t.stepsTick(r.label)}
                  accessibilityState={{ checked }}
                  onPress={() => onTick(r.index, r.item!, !checked)}
                  hitSlop={6}
                  style={styles.tickTarget}
                >
                  <View style={[styles.tick, checked && styles.tickOn]}>
                    {checked ? <Codicon name="check" size={14} color={c.onAccent} /> : null}
                  </View>
                </Pressable>
              ) : null}
            </View>
            {asked ? (
              <View testID={`steps-answers-${r.key}`} style={styles.answers}>
                {asked.question ? (
                  <Text testID={`steps-question-${r.key}`} style={styles.question} numberOfLines={3}>
                    {asked.question}
                  </Text>
                ) : null}
                <View style={styles.buttons}>
                  {asked.buttons.map((b, i) => {
                    const kind = b.kind ?? (i === 0 ? 'primary' : 'secondary');
                    return (
                      <Pressable
                        key={b.id}
                        testID={`steps-answer-${r.key}-${b.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={t.stepsAnswerLabel(b.label, r.label)}
                        {...(b.hint ? { accessibilityHint: b.hint } : {})}
                        onPress={b.onPress}
                        style={({ pressed }) => [
                          kind === 'primary' ? styles.answerMain : styles.answerOther,
                          pressed && styles.answerPressed,
                        ]}
                      >
                        <Text
                          style={
                            kind === 'primary' ? styles.answerMainText : kind === 'stop' ? styles.answerStopText : styles.answerOtherText
                          }
                        >
                          {b.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const useStyles = themedStyles((c) => ({
  list: { paddingVertical: 4 },
  chapter: { paddingTop: 12, paddingBottom: 4, paddingHorizontal: 8, borderRadius: 6, minHeight: 36, justifyContent: 'flex-end' },
  chapterText: { fontSize: 13, fontWeight: '600', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.3 },
  chapterTop: { fontSize: 14, color: c.text },
  row: { borderRadius: 6 },
  top: { flexDirection: 'row', alignItems: 'center' },
  main: { flex: 1, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 6, minHeight: 44, justifyContent: 'center' },
  seen: { backgroundColor: c.lineHighlight },
  pressed: { backgroundColor: c.codeBackground },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glyph: { width: 22, fontSize: 14, textAlign: 'center', fontWeight: '700' },
  glyphBox: { width: 22, alignItems: 'center' },
  num: { minWidth: 22, fontSize: 13, color: c.muted, textAlign: 'right', fontVariant: ['tabular-nums'] },
  label: { flex: 1, fontSize: 15, color: c.text },
  labelActive: { fontWeight: '600' },
  waiting: { color: c.warningText },
  time: { fontSize: 13, color: c.muted, fontVariant: ['tabular-nums'] },
  over: { color: c.warningText },
  bar: { marginTop: 6, marginLeft: 60 },
  needs: { marginTop: 2, marginLeft: 60, fontSize: 13, color: c.warningText },
  error: { marginTop: 2, marginLeft: 60, fontSize: 13, color: c.error },
  // A 44 px target around a box drawn smaller.
  tickTarget: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  tick: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: c.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: c.ok, borderColor: c.ok },
  answers: { marginLeft: 68, marginRight: 8, marginBottom: 8, gap: 6 },
  question: { fontSize: 13, color: c.warningText },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  answerMain: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 6, backgroundColor: c.accent },
  answerOther: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 6 },
  answerPressed: { opacity: 0.6 },
  answerMainText: { fontSize: 15, color: c.onAccent },
  answerOtherText: { fontSize: 15, color: c.link },
  answerStopText: { fontSize: 15, color: c.error },
}));

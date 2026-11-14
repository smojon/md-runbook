/**
 * The runbook's steps by name (runbooks/steps.ts): chapters as headings, each step with its state
 * as a symbol and a colour (✓ done, ✕ failed, ▶ running, a pause icon waiting for you, ○ to do), its
 * number, its name and its time. A row goes to its cell. The rows of the cells on screen are
 * shaded; the list keeps the running (or waiting) step in view. The Steps sheet and the wide
 * screen's side panel both draw it.
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

export function StepsList({
  rows,
  visible,
  onGo,
}: {
  rows: readonly StepsRow[];
  /** The cells on screen, first and last: their rows are shaded. */
  visible?: { first: number; last: number };
  onGo(index: number): void;
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
        return (
          <Pressable
            key={r.key}
            testID={`steps-row-${r.key}`}
            accessibilityRole="button"
            accessibilityLabel={t.stepsRowLabel(r.step, r.label, t.stepsState[r.state], r.time) + (needs ? '. ' + t.stepsNeeds(needs) : '')}
            accessibilityState={{ selected: active }}
            onPress={() => onGo(r.index)}
            onLayout={(e) => remember(e.nativeEvent.layout.y)}
            style={({ pressed }) => [styles.row, seen && styles.seen, pressed && styles.pressed]}
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
            {r.fraction !== undefined ? (
              <View style={styles.bar}>
                <TimeBar fraction={r.fraction} over={r.over === true} />
              </View>
            ) : null}
          </Pressable>
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
  row: { paddingVertical: 8, paddingHorizontal: 8, borderRadius: 6, minHeight: 44, justifyContent: 'center' },
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
}));

/**
 * The runbook's progress as a rail down the left edge of the screen, always in view: it fills
 * from the top as the run goes down the runbook, with a tick per step (done, failed, running,
 * still to do) where the step is in the runbook, a crossbar per `#`/`##` chapter, and a pale box
 * for the part on screen. Positions are by cell: the runbook's cells spread over the rail's height.
 *
 * The rail is a scrubber: press and drag along it and a bubble names the chapter and the step at
 * the finger; let go and the runbook goes there. A plain tap shows the Steps sheet, the list of
 * every step by name (the visible way to the same places, and what a screen reader opens).
 *
 * The touch strip is 44 px wide (the rail drawn in it is thin) and takes a column of its own, so
 * it never covers a cell's ▷. The drawn rail sits 20 px in from the screen's edge, away from the
 * back swipe of iOS and Android, which is sideways: the scrubber only follows up and down.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, GestureResponderEvent, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles, usePalette } from '../theme';
import { usePulse } from './motion';

export type RailState = 'done' | 'failed' | 'running' | 'pending';

/** A `#` or `##` heading: a crossbar on the rail. */
export interface RailChapter {
  /** The Markdown cell holding the heading. */
  index: number;
  title: string;
}

export interface RailTick {
  /** The cell's index in the runbook. */
  index: number;
  /** 1-based step number. */
  step: number;
  /** The step's name, for the bubble. */
  label?: string;
  state: RailState;
}

/** The width of the touch strip (and of the rail's column). */
export const RAIL_WIDTH = 44;
const TICK = 8;
/** Where the drawn rail is in the strip (its middle). */
const MID = 22;
/** A move this far (px) makes a press a scrub; a press held this long (ms) does too. */
const DRAG = 8;
const HOLD = 250;

/** What a scrub would go to: the step or chapter whose mark is nearest the finger. */
interface Target {
  index: number;
  chapter?: string;
  step?: { n: number; label?: string };
}

export function ProgressRail({
  cells,
  ticks,
  chapters = [],
  visible,
  onGo,
  onOpen,
  label,
}: {
  /** The runbook's chapters (`#` and `##` headings), in order. */
  chapters?: readonly RailChapter[];
  /** How many cells the runbook has: a cell's place on the rail is index / cells. */
  cells: number;
  ticks: readonly RailTick[];
  /** The cells on screen, first and last. */
  visible?: { first: number; last: number };
  /** A scrub ended here: go to the cell. */
  onGo(index: number): void;
  /** A tap: show the Steps sheet. */
  onOpen(): void;
  /** What a screen reader says for the whole rail, e.g. "Step 3 of 6". */
  label: string;
}) {
  const styles = useStyles();
  const c = usePalette();
  const [height, setHeight] = useState(0);
  const pulse = usePulse(ticks.some((x) => x.state === 'running'));
  /** While scrubbing: the finger's place on the rail and what is there. */
  const [scrub, setScrub] = useState<{ y: number; target: Target } | undefined>();

  const span = Math.max(1, cells);
  const at = (index: number): number => ((index + 0.5) / span) * height;
  // Filled down to the step running now, else past the last step done or failed.
  const reached = [...ticks].reverse().find((x) => x.state !== 'pending');
  const fill = reached ? at(reached.index) + (reached.state === 'running' ? 0 : TICK / 2) : 0;
  const color = (s: RailState): string => (s === 'done' ? c.ok : s === 'failed' ? c.error : s === 'running' ? c.accent : c.background);

  const targetAt = (y: number): Target | undefined => {
    let best: { index: number; d: number; tick?: RailTick } | undefined;
    for (const x of ticks) {
      const d = Math.abs(at(x.index) - y);
      if (!best || d < best.d) best = { index: x.index, d, tick: x };
    }
    for (const ch of chapters) {
      const d = Math.abs(at(ch.index) - y);
      // A step wins a tie: it is where the work is.
      if (!best || d < best.d) best = { index: ch.index, d };
    }
    if (!best) return undefined;
    const chapter = [...chapters].reverse().find((ch) => ch.index <= best.index)?.title;
    return {
      index: best.index,
      ...(chapter !== undefined ? { chapter } : {}),
      ...(best.tick ? { step: { n: best.tick.step, ...(best.tick.label ? { label: best.tick.label } : {}) } } : {}),
    };
  };

  // The gesture, in refs: its handlers outlive a render (the responder keeps the first one's).
  const latest = useRef({ targetAt, height, onGo, onOpen });
  useEffect(() => {
    latest.current = { targetAt, height, onGo, onOpen };
  });
  const press = useRef<{ y0: number; page0: number; scrubbing: boolean; timer?: ReturnType<typeof setTimeout> } | undefined>(undefined);
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  /** What a release goes to (the bubble's target), as of the last move. */
  const aimed = useRef<Target | undefined>(undefined);
  const show = (y: number): void => {
    const h = latest.current.height;
    const at = Math.min(Math.max(0, y), h);
    const target = latest.current.targetAt(at);
    aimed.current = target;
    setScrub(target ? { y: at, target } : undefined);
  };
  const end = (go: boolean): void => {
    const p = press.current;
    press.current = undefined;
    if (!p) return;
    clearTimeout(p.timer);
    const target = p.scrubbing ? aimed.current : undefined;
    aimed.current = undefined;
    setScrub(undefined);
    if (!go) return;
    // A scrub goes where the bubble said; a plain tap shows every step by name.
    if (target) latest.current.onGo(target.index);
    else if (!p.scrubbing) latest.current.onOpen();
  };
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    // Once pressed, the rail keeps the touch (a scrub that turns into a list scroll loses its place).
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      const y0 = e.nativeEvent.locationY;
      const p = { y0, page0: e.nativeEvent.pageY, scrubbing: false } as NonNullable<typeof press.current>;
      // Held still: a scrub at the finger (the bubble says where a release goes).
      p.timer = setTimeout(() => {
        if (press.current !== p) return;
        p.scrubbing = true;
        show(p.y0);
      }, HOLD);
      press.current = p;
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const p = press.current;
      if (!p) return;
      const y = p.y0 + (e.nativeEvent.pageY - p.page0);
      if (!p.scrubbing && Math.abs(y - p.y0) < DRAG) return;
      p.scrubbing = true;
      clearTimeout(p.timer);
      show(y);
    },
    onResponderRelease: () => end(true),
    onResponderTerminate: () => end(false),
  };

  const target = scrub?.target;
  return (
    <View
      testID="progress-rail"
      style={styles.rail}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t.railHint}
      onAccessibilityTap={onOpen}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') onOpen();
      }}
      {...responder}
    >
      {visible && height > 0 ? (
        <View
          testID="progress-rail-view"
          pointerEvents="none"
          style={[
            styles.view,
            { top: (visible.first / span) * height, height: Math.max(TICK, ((visible.last - visible.first + 1) / span) * height) },
          ]}
        />
      ) : null}
      <View pointerEvents="none" style={styles.track} />
      <View testID="progress-rail-fill" pointerEvents="none" style={[styles.fill, { height: fill }]} />
      {chapters.map((ch) => (
        <View
          key={`h${ch.index}`}
          testID={`rail-chapter-${ch.index}`}
          pointerEvents="none"
          style={[styles.chapter, target?.index === ch.index && !target.step && styles.chapterOn, { top: at(ch.index) - 1 }]}
        />
      ))}
      {/* Before the rail is measured, every tick sits at the top (they move once it is). */}
      {ticks.map((x) => (
        <Animated.View
          key={x.index}
          testID={`rail-tick-${x.index}`}
          pointerEvents="none"
          style={[
            styles.tick,
            { top: at(x.index) - TICK / 2, backgroundColor: color(x.state), borderColor: x.state === 'pending' ? c.muted : color(x.state) },
            target?.step && target.index === x.index && styles.tickOn,
            x.state === 'running' && { opacity: pulse },
          ]}
        />
      ))}
      {scrub && target ? (
        // A holder of its own width: inside the narrow rail, native layout left the text no room.
        <View pointerEvents="none" style={[styles.bubbleHolder, { top: Math.max(0, Math.min(scrub.y - 56, height - 56)) }]}>
          <View testID="rail-bubble" style={styles.bubble}>
            {target.chapter !== undefined ? (
              <Text testID="rail-bubble-chapter" style={target.step ? styles.bubbleChapter : styles.bubbleStep} numberOfLines={1}>
                {target.chapter}
              </Text>
            ) : null}
            {target.step ? (
              <Text testID="rail-bubble-step" style={styles.bubbleStep} numberOfLines={1}>
                {`${target.step.n} · ${target.step.label ?? t.cellNumber(target.index + 1)}`}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  rail: { width: RAIL_WIDTH, alignSelf: 'stretch', marginVertical: 8, zIndex: 2 },
  chapter: { position: 'absolute', left: MID - 7, width: 14, height: 2, borderRadius: 1, backgroundColor: c.muted },
  chapterOn: { left: MID - 10, width: 20, height: 3, backgroundColor: c.text },
  bubbleHolder: { position: 'absolute', left: RAIL_WIDTH, width: 260, alignItems: 'flex-start' },
  bubble: {
    maxWidth: 260,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: c.text,
  },
  bubbleChapter: { fontSize: 12, color: c.background, opacity: 0.8 },
  bubbleStep: { fontSize: 14, fontWeight: '600', color: c.background },
  view: { position: 'absolute', left: MID - 8, width: 16, borderRadius: 4, backgroundColor: c.accent, opacity: 0.12 },
  track: { position: 'absolute', top: 0, bottom: 0, left: MID - 2, width: 4, borderRadius: 2, backgroundColor: c.border },
  fill: { position: 'absolute', top: 0, left: MID - 2, width: 4, borderRadius: 2, backgroundColor: c.accent },
  tick: { position: 'absolute', left: MID - TICK / 2, width: TICK, height: TICK, borderRadius: TICK / 2, borderWidth: 1.5 },
  tickOn: { transform: [{ scale: 1.6 }] },
}));

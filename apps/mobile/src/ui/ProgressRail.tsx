/**
 * The runbook's progress as a rail down the left edge of the screen, always in view: it fills
 * from the top as the run goes down the runbook, with a tick per step (done, failed, running,
 * still to do) where the step is in the runbook, a crossbar per `#`/`##` chapter, and a pale box
 * for the part on screen. A tick goes to its step; a crossbar to its chapter, named for a moment. Positions are by cell: the runbook's cells spread over the rail's height.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, Text, View } from 'react-native';
import { themedStyles, usePalette } from '../theme';

export type RailState = 'done' | 'failed' | 'running' | 'pending';

/** A `#` or `##` heading: a crossbar on the rail that goes to its chapter. */
export interface RailChapter {
  /** The Markdown cell holding the heading. */
  index: number;
  title: string;
}

export interface RailTick {
  /** The cell's index in the runbook. */
  index: number;
  /** 1-based step number, for screen readers. */
  step: number;
  /** The step's name, for screen readers. */
  label?: string;
  state: RailState;
}

const TICK = 8;

export function ProgressRail({
  cells,
  ticks,
  chapters = [],
  visible,
  onGo,
  label,
}: {
  /** The runbook's chapters (`#` and `##` headings), in order. */
  chapters?: readonly RailChapter[];
  /** How many cells the runbook has: a cell's place on the rail is index / cells. */
  cells: number;
  ticks: readonly RailTick[];
  /** The cells on screen, first and last. */
  visible?: { first: number; last: number };
  onGo(index: number): void;
  /** What a screen reader says for the whole rail, e.g. "Step 3 of 6". */
  label: string;
}) {
  const styles = useStyles();
  const c = usePalette();
  const [height, setHeight] = useState(0);
  // The chapter just tapped, named beside the rail for a moment.
  const [named, setNamed] = useState<RailChapter | undefined>();
  useEffect(() => {
    if (!named) return undefined;
    const t = setTimeout(() => setNamed(undefined), 1800);
    return () => clearTimeout(t);
  }, [named]);
  const [pulse] = useState(() => new Animated.Value(1));
  const running = ticks.some((t) => t.state === 'running');
  // The system's Reduce Motion: the running tick holds still.
  const [still, setStill] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setStill(on));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setStill);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  useEffect(() => {
    if (!running || still) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [running, still, pulse]);

  const span = Math.max(1, cells);
  const at = (index: number): number => ((index + 0.5) / span) * height;
  // Filled down to the step running now, else past the last step done or failed.
  const reached = [...ticks].reverse().find((t) => t.state !== 'pending');
  const fill = reached ? at(reached.index) + (reached.state === 'running' ? 0 : TICK / 2) : 0;
  const color = (s: RailState): string => (s === 'done' ? c.ok : s === 'failed' ? c.error : s === 'running' ? c.accent : c.background);

  return (
    <View
      testID="progress-rail"
      style={styles.rail}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
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
        <Pressable
          key={`h${ch.index}`}
          testID={`rail-chapter-${ch.index}`}
          accessibilityRole="button"
          accessibilityLabel={`Chapter: ${ch.title}`}
          hitSlop={4}
          onPress={() => {
            setNamed(ch);
            onGo(ch.index);
          }}
          style={[styles.chapterHit, { top: at(ch.index) - 6 }]}
        >
          <View style={styles.chapter} />
        </Pressable>
      ))}
      {named ? (
        // A holder of its own width: inside the 16 px rail, native layout left the text no room
        // (the name showed as an empty pill on iOS and Android; the web lays it out differently).
        <View pointerEvents="none" style={[styles.nameHolder, { top: Math.max(0, at(named.index) - 12) }]}>
          <View testID="rail-chapter-name" style={styles.name}>
            <Text style={styles.nameText} numberOfLines={1}>
              {named.title}
            </Text>
          </View>
        </View>
      ) : null}
      {/* Before the rail is measured, every tick sits at the top (they move once it is). */}
      {ticks.map((t) => (
        <Pressable
          key={t.index}
          testID={`rail-tick-${t.index}`}
          accessibilityRole="button"
          accessibilityLabel={`Step ${t.step}${t.label ? `: ${t.label}` : ''}, ${t.state === 'pending' ? 'to do' : t.state}`}
          hitSlop={6}
          onPress={() => onGo(t.index)}
          style={[styles.hit, { top: at(t.index) - 8 }]}
        >
          <Animated.View
            style={[
              styles.tick,
              { backgroundColor: color(t.state), borderColor: t.state === 'pending' ? c.muted : color(t.state) },
              t.state === 'running' && { opacity: pulse },
            ]}
          />
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  rail: { width: 16, alignSelf: 'stretch', marginVertical: 8, zIndex: 2 },
  chapterHit: { position: 'absolute', left: 0, width: 16, height: 12, justifyContent: 'center' },
  chapter: { height: 2, marginHorizontal: 1, borderRadius: 1, backgroundColor: c.muted },
  nameHolder: { position: 'absolute', left: 18, width: 240, alignItems: 'flex-start' },
  name: {
    maxWidth: 240,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: c.text,
  },
  nameText: { fontSize: 13, color: c.background },
  view: { position: 'absolute', left: 1, right: 1, borderRadius: 4, backgroundColor: c.accent, opacity: 0.12 },
  track: { position: 'absolute', top: 0, bottom: 0, left: 6, width: 4, borderRadius: 2, backgroundColor: c.border },
  fill: { position: 'absolute', top: 0, left: 6, width: 4, borderRadius: 2, backgroundColor: c.accent },
  hit: { position: 'absolute', left: 0, width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  tick: { width: TICK, height: TICK, borderRadius: TICK / 2, borderWidth: 1.5 },
}));

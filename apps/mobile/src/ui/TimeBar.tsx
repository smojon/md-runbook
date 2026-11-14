/**
 * Time against an estimate (estimate=): a thin bar, full at the estimate and after it, in the
 * warning colour once past it (never looping or overflowing). `useNow` ticks while something runs.
 * With `segments`, one bar in parts (core/parts.ts): the setup, the runbook's own steps and the
 * teardown, each as wide as its estimate and filling on its own.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { themedStyles } from '../theme';

/** Date.now(), again every `ms` while `active` (a running block's bar moves on without output). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/**
 * A part of a segmented bar: `weight` its share of the width (seconds), `fraction` how far it is,
 * `kind` how it looks: `solid`; `maybe` (a setup the ready check may skip: pale accent);
 * `offered` (a teardown not chosen yet: paler than the track).
 */
export interface BarSegment {
  weight: number;
  fraction: number;
  kind: 'solid' | 'maybe' | 'offered';
  testID?: string;
}

/** A segment never narrower than this share of the bar, so a 2-minute teardown still shows. */
const MIN_SHARE = 0.08;

const clamp = (f: number): number => Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));

export function TimeBar({
  fraction,
  over = false,
  testID,
  segments,
}: {
  fraction: number;
  over?: boolean;
  testID?: string;
  segments?: readonly BarSegment[];
}) {
  const styles = useStyles();
  const f = clamp(fraction);
  const shown = segments?.filter((s) => s.weight > 0) ?? [];
  if (shown.length > 1) {
    const total = shown.reduce((a, s) => a + s.weight, 0);
    const weights = shown.map((s) => Math.max(s.weight, total * MIN_SHARE));
    return (
      <View
        testID={testID}
        style={styles.row}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(f * 100) }}
      >
        {shown.map((s, i) => (
          <View
            key={i}
            testID={s.testID}
            style={[styles.segment, { flexGrow: weights[i]! }, s.kind === 'maybe' && styles.maybe, s.kind === 'offered' && styles.offered]}
          >
            {s.kind === 'offered' ? null : <View style={[styles.fill, { width: `${clamp(s.fraction) * 100}%` }]} />}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View
      testID={testID}
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(f * 100) }}
    >
      <View style={[styles.fill, over && styles.over, { width: `${f * 100}%` }]} />
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  track: { height: 6, borderRadius: 3, backgroundColor: c.border, overflow: 'hidden', flexGrow: 1, minWidth: 60 },
  fill: { height: 6, backgroundColor: c.accent },
  over: { backgroundColor: c.warning },
  row: { flexDirection: 'row', gap: 3, flexGrow: 1, minWidth: 60, alignItems: 'center' },
  segment: { height: 6, flexBasis: 0, borderRadius: 3, backgroundColor: c.border, overflow: 'hidden' },
  // A setup the ready check may skip: a pale accent until it runs (a dashed outline read as broken).
  maybe: { backgroundColor: c.accent, opacity: 0.3 },
  // A teardown not chosen: paler than the track, never filled.
  offered: { opacity: 0.45 },
}));

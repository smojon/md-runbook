/**
 * Time against an estimate (estimate=): a thin bar, full at the estimate and after it, in the
 * warning colour once past it (never looping or overflowing). `useNow` ticks while something runs.
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

export function TimeBar({ fraction, over = false, testID }: { fraction: number; over?: boolean; testID?: string }) {
  const styles = useStyles();
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
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
  track: { height: 4, borderRadius: 2, backgroundColor: c.border, overflow: 'hidden', flexGrow: 1, minWidth: 60 },
  fill: { height: 4, backgroundColor: c.accent },
  over: { backgroundColor: c.warning },
}));

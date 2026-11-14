/**
 * Motion that respects the system's Reduce Motion (iOS, Android's Remove animations, the
 * browser's prefers-reduced-motion): a pulse for what runs now, held still when motion is off.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';

/** Whether the system asks for less motion; follows the setting while the screen is open. */
export function useReduceMotion(): boolean {
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
  return still;
}

/** An opacity that pulses (1 → 0.3 → 1) while `active`, and stays at 1 with Reduce Motion. */
export function usePulse(active: boolean): Animated.Value {
  const still = useReduceMotion();
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active || still) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, still, pulse]);
  return pulse;
}

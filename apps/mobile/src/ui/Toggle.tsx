/**
 * An on/off toggle drawn the same on every platform, in the iOS style: a pill that fills with the
 * accent colour when on, a white knob with a soft shadow that slides across. React Native's own
 * Switch looks different on each platform (on the web a thin track with a knob sticking out).
 */
import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { usePalette } from '../theme';

const W = 51;
const H = 31;
const KNOB = 27;
const TRAVEL = W - KNOB - 4;

export function Toggle({
  value,
  onValueChange,
  testID,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange(on: boolean): void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const c = usePalette();
  // One animated value for the knob's position and the track's colour (state: stable, and readable in render).
  const [at] = useState(() => new Animated.Value(value ? 1 : 0));
  useEffect(() => {
    Animated.timing(at, { toValue: value ? 1 : 0, duration: 160, useNativeDriver: false }).start();
  }, [at, value]);
  const off = c.dark ? '#39393d' : '#e9e9ea';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value }}
      aria-checked={value}
      onPress={() => onValueChange(!value)}
      hitSlop={6}
    >
      <Animated.View style={[styles.track, { backgroundColor: at.interpolate({ inputRange: [0, 1], outputRange: [off, c.accent] }) }]}>
        <Animated.View
          style={[styles.knob, { transform: [{ translateX: at.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }) }] }]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: W, height: H, borderRadius: H / 2, padding: 2, justifyContent: 'center' },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: '#ffffff',
    boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.2)',
  },
});

import { Platform } from 'react-native';

/**
 * Whether the camera can be used: always on the phones; in a browser only in a secure context
 * (an https page, or localhost) that offers getUserMedia. An http page reached by its address
 * (http://192.168.1.10:8080) has no camera at all: the browser doesn't even ask.
 */
export function cameraUsable(): boolean {
  if (Platform.OS !== 'web') return true;
  const g = globalThis as { isSecureContext?: boolean; navigator?: { mediaDevices?: { getUserMedia?: unknown } } };
  return g.isSecureContext === true && typeof g.navigator?.mediaDevices?.getUserMedia === 'function';
}

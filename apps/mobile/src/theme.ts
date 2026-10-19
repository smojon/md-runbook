import { Platform } from 'react-native';

export const colors = {
  background: '#ffffff',
  text: '#1f2328',
  muted: '#59636e',
  border: '#d1d9e0',
  codeBackground: '#f6f8fa',
  ok: '#1a7f37',
  error: '#d1242f',
} as const;

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });

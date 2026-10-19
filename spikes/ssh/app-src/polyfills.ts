/**
 * Globals the SSH library expects, installed before anything else loads (index.ts imports this
 * first: imports run before a module's own code, so this can't live in App.tsx).
 */
import { install } from 'react-native-quick-crypto';
import { Buffer } from 'buffer';

install(); // Node-style crypto for the library (it takes its Node crypto path on React Native)
const g = globalThis as { Buffer?: unknown };
g.Buffer ??= Buffer;

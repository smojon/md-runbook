/**
 * Globals the SSH library expects on iOS and Android. It takes its Node crypto path there, which
 * react-native-quick-crypto provides natively (OpenSSL). The web build uses polyfills.web.ts.
 */
import { Buffer } from 'buffer';
import { install } from 'react-native-quick-crypto';

install();
const g = globalThis as { Buffer?: unknown };
g.Buffer ??= Buffer;

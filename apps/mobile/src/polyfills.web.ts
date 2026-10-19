/** Web: the browser's Web Crypto serves the SSH library; only Buffer is missing. */
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: unknown };
g.Buffer ??= Buffer;

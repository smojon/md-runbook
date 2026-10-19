// Browsers have no global Buffer or process; the SSH library and its stream port use them.
// esbuild injects these wherever `Buffer` or `process` is used without an import.
export { Buffer } from 'buffer';
import process from 'process/browser';
export { process };

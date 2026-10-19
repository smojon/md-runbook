// Browsers have no global Buffer; the SSH library uses one. esbuild injects this wherever
// `Buffer` is used without an import.
export { Buffer } from 'buffer';

/** Pure parser/serializer/redaction core. Must not import 'vscode'. */
export * from './model';
export * from './lines';
export * from './languages';
export { parse } from './parser';
export { serialize } from './writer';
export {
  OUTPUT_END_RE,
  OUTPUT_START_RE,
  formatLocalIso,
  formatOutputBlock,
  processOutputText,
  truncateLines,
} from './outputBlock';
export { stripAnsi } from './ansi';
export { DEFAULT_PATTERNS, REDACTED, RedactionPattern, Redactor, createRedactor } from './redact';

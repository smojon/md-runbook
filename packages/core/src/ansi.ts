/**
 * ANSI escape sequence stripping. Pattern adapted from chalk/ansi-regex (MIT): CSI and OSC
 * sequences, including OSC 8 hyperlinks terminated by BEL or ST.
 */
const ANSI_RE = new RegExp(
  [
    // OSC with any payload: window titles hold Windows paths (backslashes, spaces).
    '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\u005C|\\u009C)',
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

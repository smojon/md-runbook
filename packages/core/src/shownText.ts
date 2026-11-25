/**
 * Text from outside (a certificate's key ID or principals) made safe to show on one line: control
 * characters (C0, DEL, C1), line and paragraph separators and bidi controls become `\u{…}`
 * escapes, so a value can't fake another line or reorder what follows; long text is cut with `…`.
 */

const escaped = (n: number): boolean =>
  n < 0x20 ||
  (n >= 0x7f && n <= 0x9f) ||
  n === 0x200e ||
  n === 0x200f ||
  n === 0x2028 ||
  n === 0x2029 ||
  (n >= 0x202a && n <= 0x202e) ||
  (n >= 0x2066 && n <= 0x2069);

/** `s` on one line, escaped, at most `max` characters (code points) before the escapes. */
export function shownText(s: string, max = 64): string {
  const chars = [...s];
  const cut = chars.length > max;
  const out = (cut ? chars.slice(0, max) : chars).map((c) => {
    const n = c.codePointAt(0)!;
    return escaped(n) ? `\\u{${n.toString(16)}}` : c;
  });
  return out.join('') + (cut ? '…' : '');
}

/** Items joined with `, `, each shown safely; past `maxItems`, `+N more`. */
export function shownList(items: readonly string[], maxItems = 8, max = 64): string {
  const shown = items.slice(0, maxItems).map((i) => shownText(i, max));
  return items.length > maxItems ? `${shown.join(', ')}, +${items.length - maxItems} more` : shown.join(', ');
}

/**
 * Text from outside (a certificate's key ID or principals) made safe to show on one line: control
 * characters (C0, DEL, C1), line and paragraph separators and bidi controls become `\u{…}`
 * escapes, so a value can't fake another line or reorder what follows; long text is cut with `…`.
 */

/** Bidi controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069): they reorder the text shown. */
export const isBidiControl = (n: number): boolean => n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);

/** Characters shown as nothing: zero-width space and joiners (U+200B–U+200D), word joiner (U+2060), U+FEFF. */
export const isInvisible = (n: number): boolean => (n >= 0x200b && n <= 0x200d) || n === 0x2060 || n === 0xfeff;

/**
 * The first bidi control or invisible character of `s`: its index and `U+XXXX`, or undefined. A
 * reviewer can't see them, and a bidi control shows code in another order than it runs (Trojan
 * Source, CVE-2021-42574).
 */
export function hiddenCharacter(s: string): { index: number; code: string; bidi: boolean } | undefined {
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i);
    if (isBidiControl(n) || isInvisible(n)) return { index: i, code: `U+${n.toString(16).toUpperCase().padStart(4, '0')}`, bidi: isBidiControl(n) };
  }
  return undefined;
}

const escaped = (n: number): boolean => n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || isBidiControl(n);

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

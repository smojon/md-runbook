/**
 * Parts of one line read in a single pass, where a regular expression with a lazy part and
 * optional trailing groups (`(.*?)\s*(#.*)?$`, `\s+#.*$`) backtracked quadratically or worse on a
 * long run of blanks that didn't end as expected (a letter, or U+2028, which `.` doesn't match).
 * U+2028 and U+2029 are ordinary characters inside a line here, as in CommonMark and YAML 1.2.
 */

/** JavaScript's `\s` (what `trim` removes). */
export const isWhitespace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
export const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';
export const isSpace = (c: string | undefined): boolean => c === ' ';

/**
 * `s` before its `#` comment: cut at the whitespace before the first `#` that follows whitespace,
 * as `s.replace(/\s+#.*$/, '')` did (`a # c` → `a`, `a#b` stays). `space` says what counts as
 * whitespace (`[ \t]+#`, ` +#`); `atStart`: a `#` at the very start is a comment too (`(^|\s+)#`).
 */
export function beforeComment(s: string, space: (c: string | undefined) => boolean = isWhitespace, atStart = false): string {
  for (let j = s.indexOf('#'); j >= 0; j = s.indexOf('#', j + 1)) {
    if (j === 0) {
      if (atStart) return '';
      continue;
    }
    if (space(s[j - 1])) {
      let k = j - 1;
      while (k > 0 && space(s[k - 1])) k--;
      return s.slice(0, k);
    }
  }
  return s;
}

/**
 * After a `key:` and the whitespace after it: the value up to the first `#` (or the end), without
 * the whitespace before that, as the lazy `(.*?)\s*(#.*)?$` read it; `hash` from the `#` on.
 */
export function valueAndHash(rest: string): { value: string; hash?: string } {
  const j = rest.indexOf('#');
  return j < 0 ? { value: rest.trimEnd() } : { value: rest.slice(0, j).trimEnd(), hash: rest.slice(j) };
}

/** `s` without the characters `space` matches at its end (`s.replace(/ +$/, '')` without backtracking). */
export function trimEndWith(s: string, space: (c: string | undefined) => boolean): string {
  let end = s.length;
  while (end > 0 && space(s[end - 1])) end--;
  return s.slice(0, end);
}

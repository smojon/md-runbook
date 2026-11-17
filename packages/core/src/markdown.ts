/**
 * A deliberately small Markdown -> HTML renderer for reports: headings, paragraphs, lists, task
 * lists, block quotes, tables, fenced code, inline code, emphasis and links. Raw HTML in the
 * source is never passed through: it is escaped like any other text, and HTML comments
 * (including md-runbook markers) are dropped.
 */

import { isFenceClose, langOf, matchFenceOpen } from './fence';
import { toLf } from './lines';
import { isBlank, trimEndWith } from './lineText';
import { atxHeading } from './title';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);
}

/**
 * Only http(s), mailto and scheme-less (relative or #anchor) links are kept. Protocol-relative
 * links (`//host`, `\\host` and mixes) are dropped: from a file:// report they become UNC/SMB
 * paths on Windows, and clicking one can leak NTLM credentials.
 */
export function safeUrl(url: string): string | undefined {
  if (/[\x00-\x20\x7f]/.test(url)) return undefined;
  if (/^[\\/]{2}/.test(url)) return undefined;
  const scheme = /^([^/?#]*?):/.exec(url);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1]!)) return undefined;
  return url;
}

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// `[\s\S]*`, not `.*`: U+2028 is text inside a line, and `.` stopping there made LIST_RE
// backtrack quadratically through the blanks after the marker.
const LIST_RE = /^([ \t]*)([-*+]|(\d{1,9})[.)])([ \t]+|$)([\s\S]*)$/;
const QUOTE_RE = /^ {0,3}> ?([\s\S]*)$/;
/**
 * A table's separator row (`| --- | :-: |`): cells of `:?-+:?` between pipes, blanks around them.
 * Read by splitting on `|`: the pattern it replaces backtracked quadratically on a long run of
 * blanks (its blanks after a cell and before the line end could split the run any way).
 */
function isTableSep(line: string): boolean {
  let s = trimEndWith(line, isBlank);
  let k = 0;
  while (isBlank(s[k])) k++;
  s = s.slice(k);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}
const BLANK_RE = /^[ \t]*$/;

function indentWidth(s: string): number {
  let w = 0;
  for (const c of s) w += c === '\t' ? 4 - (w % 4) : 1;
  return w;
}

/** A code block with a language label; shared with the report so runnable steps look the same. */
export function renderCodeBlock(code: string, lang: string): string {
  const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
  return `<div class="code">${label}<pre><code>${escapeHtml(code)}</code></pre></div>\n`;
}

/** Applied to the text of fenced code blocks while rendering (redaction); set by renderMarkdown. */
let codeTransform: (code: string) => string = (c) => c;

/** `redactCode` is applied to fenced code blocks (secrets in commands must not reach a report). */
export function renderMarkdown(text: string, redactCode?: (code: string) => string): string {
  const saved = codeTransform;
  codeTransform = redactCode ?? ((c) => c);
  try {
    return renderBlocks(toLf(text).split('\n'));
  } finally {
    codeTransform = saved;
  }
}

function startsBlock(line: string): boolean {
  return atxHeading(line) !== undefined || HR_RE.test(line) || QUOTE_RE.test(line) || matchFenceOpen(line) !== null || /^[ \t]*<!--/.test(line);
}

function renderBlocks(lines: string[]): string {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK_RE.test(line)) {
      i++;
      continue;
    }

    // HTML comments are invisible in rendered Markdown; drop them (and md-runbook markers).
    if (/^[ \t]*<!--/.test(line)) {
      while (i < lines.length && !lines[i]!.includes('-->')) i++;
      i++;
      continue;
    }

    const fence = matchFenceOpen(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j]!, fence)) j++;
      const strip = (l: string): string => l.replace(new RegExp(`^[ \\t]{0,${fence.indent.length}}`), '');
      html += renderCodeBlock(codeTransform(lines.slice(i + 1, j).map(strip).join('\n')), langOf(fence.info));
      i = j + 1;
      continue;
    }

    const heading = atxHeading(line);
    if (heading) {
      const level = heading.level;
      html += `<h${level}>${renderInline(heading.text)}</h${level}>\n`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !BLANK_RE.test(lines[i]!)) {
        const q = QUOTE_RE.exec(lines[i]!);
        inner.push(q ? q[1]! : lines[i]!);
        i++;
      }
      html += `<blockquote>\n${renderBlocks(inner)}</blockquote>\n`;
      continue;
    }

    if (LIST_RE.test(line)) {
      const r = renderList(lines, i);
      html += r.html;
      i = r.end;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const rows: string[] = [line];
      let j = i + 2;
      while (j < lines.length && !BLANK_RE.test(lines[j]!) && lines[j]!.includes('|')) rows.push(lines[j++]!);
      html += renderTable(rows);
      i = j;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !BLANK_RE.test(lines[i]!) && (para.length === 0 || (!startsBlock(lines[i]!) && !LIST_RE.test(lines[i]!)))) {
      para.push(lines[i]!);
      i++;
    }
    // Two trailing spaces or a trailing backslash make a hard line break.
    const brk = (l: string): boolean => / {2,}$|\\$/.test(l);
    const inline = para.map((l, k) => renderInline(l.trim().replace(/\\$/, '')) + (k === para.length - 1 ? '' : brk(l) ? '<br>\n' : '\n'));
    html += `<p>${inline.join('')}</p>\n`;
  }
  return html;
}

/** A list starting at `start`; items continue while lines are indented past the marker. */
function renderList(lines: string[], start: number): { html: string; end: number } {
  const first = LIST_RE.exec(lines[start]!)!;
  const baseIndent = indentWidth(first[1]!);
  const ordered = first[3] !== undefined;
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]!);
    if (m && indentWidth(m[1]!) <= baseIndent + 1 && (m[3] !== undefined) === ordered) {
      const contentIndent = indentWidth(m[1]! + m[2]! + (m[4] || ' '));
      const item = [m[5]!];
      i++;
      // Continuation: blank lines followed by indented text, or indented / lazy lines.
      while (i < lines.length) {
        const l = lines[i]!;
        if (BLANK_RE.test(l)) {
          let k = i;
          while (k < lines.length && BLANK_RE.test(lines[k]!)) k++;
          if (k < lines.length && indentWidth(/^[ \t]*/.exec(lines[k]!)![0]) >= contentIndent) {
            while (i < k) item.push(lines[i++]!.trim());
            continue;
          }
          break;
        }
        const ind = indentWidth(/^[ \t]*/.exec(l)![0]);
        if (ind >= contentIndent) item.push(dedent(l, contentIndent));
        else if (!LIST_RE.test(l) && !startsBlock(l)) item.push(l.trim());
        else break;
        i++;
      }
      items.push(item);
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first[3] !== '1' ? ` start="${parseInt(first[3]!, 10)}"` : '';
  let html = `<${tag}${startAttr}>\n`;
  for (const item of items) {
    const task = /^\[([ xX])\][ \t]+/.exec(item[0]!);
    if (task) item[0] = item[0]!.slice(task[0].length);
    const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
    // A single-paragraph item renders inline (tight list).
    const body = item.length === 1 ? renderInline(item[0]!) : renderBlocks(item).replace(/^<p>([\s\S]*?)<\/p>\n/, '$1\n');
    html += `<li${task ? ' class="task"' : ''}>${box}${body}</li>\n`;
  }
  return { html: html + `</${tag}>\n`, end: i };
}

function dedent(line: string, width: number): string {
  let w = 0;
  let k = 0;
  while (k < line.length && w < width && (line[k] === ' ' || line[k] === '\t')) {
    w += line[k] === '\t' ? 4 - (w % 4) : 1;
    k++;
  }
  return line.slice(k);
}

function renderTable(rows: string[]): string {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const [head, ...body] = rows;
  let html = '<table>\n<thead><tr>' + cells(head!).map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead>\n<tbody>\n';
  for (const r of body) html += '<tr>' + cells(r).map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>\n';
  return html + '</tbody>\n</table>\n';
}

/**
 * Inline Markdown. Code spans, escapes and links are swapped for placeholders first, so the
 * emphasis rules never touch their contents; everything else is escaped before any tag is added.
 */
export function renderInline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/\u0000/g, '');

  s = replaceCodeSpans(s, (code) => hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`));
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => hold(escapeHtml(c)));
  s = escapeHtml(s);

  // [text](url "title") and ![alt](url): images are not loaded (no external resources), only linked.
  s = replaceLinks(s, (label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    const inner = emphasis(label) || url;
    return href === undefined ? hold(inner) : hold(`<a href="${escapeHtml(href)}">${inner}</a>`);
  });
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, (_, url: string) => hold(`<a href="${url}">${url}</a>`));

  s = emphasis(s);
  // Slots can hold other slots (a code span inside a link label).
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[Number(n)]!);
  return s;
}

/**
 * Code spans: a run of backticks up to the next run of the same length (CommonMark). Read in one
 * pass: the pattern it replaces (`(`+)([\s\S]*?[^`])\1(?!`)`) took cubic time on a long run of
 * backticks (3,000 took 5 s), trying every shorter opener at every start.
 */
function replaceCodeSpans(s: string, code: (content: string) => string): string {
  if (!s.includes('`')) return s;
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== '`') {
      i++;
      continue;
    }
    const at = i;
    while (s[i] === '`') i++;
    runs.push({ at, len: i - at });
  }
  // For each length, the runs of that length in order, and how far a search has got.
  const byLen = new Map<number, number[]>();
  runs.forEach((r, k) => (byLen.get(r.len) ?? byLen.set(r.len, []).get(r.len)!).push(k));
  const cursor = new Map<number, number>();
  let out = '';
  let pos = 0;
  for (let k = 0; k < runs.length; ) {
    const r = runs[k]!;
    const same = byLen.get(r.len)!;
    let c = cursor.get(r.len) ?? 0;
    while (c < same.length && same[c]! <= k) c++;
    cursor.set(r.len, c);
    const close = same[c];
    if (close === undefined) {
      k++;
      continue;
    }
    const end = runs[close]!;
    out += s.slice(pos, r.at) + code(s.slice(r.at + r.len, end.at));
    pos = end.at + end.len;
    k = close + 1;
  }
  return out + s.slice(pos);
}

/**
 * Links on escaped text, as `!?\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^)]*?&quot;)?\)` read them,
 * in one pass: that pattern was quadratic on a long run of `[` (each one scanned to the end).
 * A `[` whose label (up to the next `]`) isn't followed by a link tail fails as every `[` before
 * that `]` does, so the scan moves past it.
 */
function replaceLinks(s: string, link: (label: string, url: string) => string): string {
  let out = '';
  let at = 0;
  // The first `)` or whitespace at or after a position, and the end of a blank run: both only
  // ever asked for further on, so each is found once.
  let urlStop = -1;
  const stop = (from: number): number => {
    if (urlStop < from) {
      urlStop = from;
      while (urlStop < s.length && s[urlStop] !== ')' && !/\s/.test(s[urlStop]!)) urlStop++;
    }
    return urlStop;
  };
  let paren = -1;
  const nextParen = (from: number): number => {
    if (paren !== -2 && paren < from) paren = s.indexOf(')', from);
    if (paren < 0) paren = -2;
    return paren === -2 ? -1 : paren;
  };
  let blanksFrom = -1;
  let blanksTo = -1;
  const tail = (k: number): { url: string; end: number } | undefined => {
    if (s[k] !== '(') return undefined;
    const u = stop(k + 1);
    const url = s.slice(k + 1, u);
    if (s[u] === ')') return { url, end: u + 1 };
    // ` &quot;title&quot;)`: blanks, then a title up to the first `)`, ending in `&quot;`.
    if (blanksFrom !== u) {
      blanksFrom = u;
      blanksTo = u;
      while (blanksTo < s.length && /\s/.test(s[blanksTo]!)) blanksTo++;
    }
    const w = blanksTo;
    if (w === u || !s.startsWith('&quot;', w)) return undefined;
    const c = nextParen(w + 6);
    if (c < 0 || c - 6 < w + 6 || !s.startsWith('&quot;', c - 6)) return undefined;
    return { url, end: c + 1 };
  };
  let i = s.indexOf('[');
  while (i >= 0) {
    const r = s.indexOf(']', i + 1);
    if (r < 0) break;
    const t = tail(r + 1);
    if (!t) {
      i = s.indexOf('[', r + 1);
      continue;
    }
    const start = i > at && s[i - 1] === '!' ? i - 1 : i;
    out += s.slice(at, start) + link(s.slice(i + 1, r), t.url);
    at = t.end;
    i = s.indexOf('[', at);
  }
  return out + s.slice(at);
}

/**
 * `s.replace(re, to)` for a global lazy `open … close` pattern, on the part of `s` a match can
 * reach: up to the last place `closes` accepts, the rest of that delimiter's run, and one more
 * character for a lookahead. Past it every opener's lazy scan ran to the end and failed, which
 * made it quadratic; the result is the same.
 */
function replaceToLastClose(s: string, re: RegExp, to: string, delim: string, closes: (q: number) => boolean): string {
  let q = s.lastIndexOf(delim);
  while (q >= 0 && !closes(q)) q = q > 0 ? s.lastIndexOf(delim, q - 1) : -1;
  if (q < 0) return s;
  let cut = q + delim.length;
  while (s[cut] === delim[0]) cut++;
  cut = Math.min(cut + 1, s.length);
  return s.slice(0, cut).replace(re, to) + s.slice(cut);
}

const nonBlank = (c: string | undefined): boolean => c !== undefined && /\S/.test(c);
const word = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);

/** Bold, italic and strikethrough on already-escaped text. */
function emphasis(s: string): string {
  // Each pattern's closing delimiter: a character before it that may end the text, and for `_`
  // no word character after it.
  s = replaceToLastClose(s, /\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>', '**', (q) => nonBlank(s[q - 1]));
  s = replaceToLastClose(s, /(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>', '__', (q) => nonBlank(s[q - 1]) && !word(s[q + 2]));
  s = replaceToLastClose(s, /\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>', '*', (q) => nonBlank(s[q - 1]) && s[q - 1] !== '*');
  s = replaceToLastClose(s, /(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>', '_', (q) => nonBlank(s[q - 1]) && s[q - 1] !== '_' && !word(s[q + 1]));
  return replaceToLastClose(s, /~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>', '~~', (q) => nonBlank(s[q - 1]));
}

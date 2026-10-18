/**
 * A deliberately small Markdown -> HTML renderer for reports: headings, paragraphs, lists, task
 * lists, block quotes, tables, fenced code, inline code, emphasis and links. Raw HTML in the
 * source is never passed through: it is escaped like any other text, and HTML comments
 * (including md-runbook markers) are dropped.
 */

import { isFenceClose, langOf, matchFenceOpen } from './fence';
import { toLf } from './lines';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);
}

/** Only http(s), mailto and scheme-less (relative or #anchor) links are kept. */
export function safeUrl(url: string): string | undefined {
  if (/[\x00-\x20\x7f]/.test(url)) return undefined;
  const scheme = /^([^/?#]*?):/.exec(url);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1]!)) return undefined;
  return url;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_RE = /^([ \t]*)([-*+]|(\d{1,9})[.)])([ \t]+|$)(.*)$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
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

export function renderMarkdown(text: string): string {
  return renderBlocks(toLf(text).split('\n'));
}

function startsBlock(line: string): boolean {
  return HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || matchFenceOpen(line) !== null || /^[ \t]*<!--/.test(line);
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
      html += renderCodeBlock(lines.slice(i + 1, j).map(strip).join('\n'), langOf(fence.info));
      i = j + 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html += `<h${level}>${renderInline(heading[2] ?? '')}</h${level}>\n`;
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

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
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

  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) =>
    hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`),
  );
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => hold(escapeHtml(c)));
  s = escapeHtml(s);

  // [text](url "title") and ![alt](url): images are not loaded (no external resources), only linked.
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^)]*?&quot;)?\)/g, (_, label: string, url: string) => {
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

/** Bold, italic and strikethrough on already-escaped text. */
function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

/**
 * Reads the HTML that the core's `renderMarkdown` writes into a tree, for the native Markdown
 * view. Only that renderer's output is ever parsed: a handful of tags, attributes in double
 * quotes, five entities, no raw HTML from the runbook (the renderer escapes it). Anything else
 * still parses, as text or as an element the view shows by its children.
 */

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlElement | string;

const VOID = new Set(['br', 'hr', 'input']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!);
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[m[1]!] = decodeEntities(m[2] ?? '');
  return attrs;
}

export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1]!;
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let pos = 0;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    if (m.index > pos) top().children.push(decodeEntities(html.slice(pos, m.index)));
    pos = m.index + m[0].length;
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      // Close the nearest open element of that name (and anything left open inside it).
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el: HtmlElement = { tag, attrs: parseAttrs(m[3]!), children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !m[3]!.endsWith('/')) stack.push(el);
  }
  if (pos < html.length) top().children.push(decodeEntities(html.slice(pos)));
  return root.children;
}

/** The text of a node and its children. */
export function textOf(n: HtmlNode): string {
  return typeof n === 'string' ? n : n.children.map(textOf).join('');
}

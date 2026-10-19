/**
 * markdown-it plugin for Markdown cells: GitHub task-list items (`- [ ] step`) become checkboxes.
 * Used by the notebook renderer (renderer/index.ts); kept free of DOM and VS Code APIs so it can be
 * unit tested.
 */

/** The parts of markdown-it this plugin uses. */
interface Token {
  type: string;
  content: string;
  map: [number, number] | null;
  children: Token[] | null;
  attrJoin(name: string, value: string): void;
}
interface StateCore {
  src: string;
  tokens: Token[];
  Token: new (type: string, tag: string, nesting: number) => Token;
}
export interface MarkdownIt {
  core: { ruler: { after(after: string, name: string, rule: (state: StateCore) => void): void } };
}

/** What a click sends to the extension (src/taskLists.ts). */
export interface ToggleMessage {
  type: 'toggleTask';
  /** The cell's Markdown source, to find the cell. */
  text: string;
  /** Line (0-based) of the item in that source. */
  line: number;
  checked: boolean;
}

export const TASK_CLASS = 'mdrb-task';

/** Same rule as TASK_RE in packages/core/src/progress.ts: `[ ]`, `[x]` or `[X]`, then a space or the end. */
const BOX_RE = /^\[([ xX])\](?=[ \t]|$)/;

/**
 * `register(src)` returns an id for the rendered source, put on each checkbox so a click can send
 * the source along. When `interactive()` is false the checkboxes are read-only.
 */
export function taskListPlugin(md: MarkdownIt, register: (src: string) => number, interactive: () => boolean): void {
  md.core.ruler.after('inline', 'mdrb_task_lists', (state) => {
    const tokens = state.tokens;
    let src: number | undefined;
    // Items in blockquotes aren't steps for the extension (packages/core/src/progress.ts), so no checkbox.
    let quoted = 0;
    for (let i = 0; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type === 'blockquote_open') quoted++;
      else if (inline.type === 'blockquote_close') quoted--;
      if (i < 2 || quoted > 0) continue;
      const para = tokens[i - 1]!;
      const item = tokens[i - 2]!;
      if (inline.type !== 'inline' || para.type !== 'paragraph_open' || item.type !== 'list_item_open' || !item.map) continue;
      // The box must be on the item's own first line.
      if (para.map?.[0] !== item.map[0]) continue;
      const first = inline.children?.[0];
      const m = first?.type === 'text' ? BOX_RE.exec(first.content) : null;
      if (!first || !m) continue;
      src ??= register(state.src);
      first.content = first.content.slice(m[0].length).replace(/^[ \t]/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content =
        `<input type="checkbox" class="${TASK_CLASS}" data-src="${src}" data-line="${item.map[0]}"` +
        `${m[1] !== ' ' ? ' checked' : ''}${interactive() ? '' : ' disabled'}` +
        ' style="margin:0 0.4em 0 -1.4em;vertical-align:middle;cursor:pointer">';
      inline.children!.unshift(box);
      item.attrJoin('style', 'list-style-type:none');
    }
  });
}

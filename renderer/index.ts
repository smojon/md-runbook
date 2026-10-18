/**
 * Notebook renderer extending VS Code's Markdown renderer (`vscode.markdown-it-renderer`): task-list
 * items in Markdown cells become checkboxes. A click asks the extension to flip that item in the
 * cell's source (src/taskLists.ts); the cell then re-renders from the new source.
 *
 * Built separately as an ES module for the notebook webview (tsconfig.renderer.json).
 */

import { MarkdownIt, TASK_CLASS, ToggleMessage, taskListPlugin } from './taskListPlugin.js';

interface RendererContext {
  postMessage?(message: unknown): void;
  getRenderer(id: string): Promise<{ extendMarkdownIt(f: (md: MarkdownIt) => void): void } | undefined>;
}

/** Recently rendered sources by id. The oldest are dropped; their cells have re-rendered since. */
const sources = new Map<number, string>();
const MAX_SOURCES = 1000;
let nextId = 0;

function register(src: string): number {
  const id = ++nextId;
  sources.set(id, src);
  if (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value as number);
  return id;
}

export async function activate(ctx: RendererContext): Promise<void> {
  const markdownIt = await ctx.getRenderer('vscode.markdown-it-renderer');
  if (!markdownIt) throw new Error('md-runbook: the Markdown renderer is not available');
  markdownIt.extendMarkdownIt((md) => taskListPlugin(md, register, () => ctx.postMessage !== undefined));

  // Cells render in shadow roots: listen on the document and take the checkbox from the event path.
  document.addEventListener(
    'click',
    (e) => {
      const box = e.composedPath()[0];
      if (!(box instanceof HTMLInputElement) || !box.classList.contains(TASK_CLASS) || box.disabled) return;
      // Keep the old state until the source changes and the cell re-renders.
      e.preventDefault();
      e.stopPropagation();
      const text = sources.get(Number(box.dataset['src']));
      if (text === undefined || !ctx.postMessage) return;
      // After preventDefault, `checked` still holds the state the click asked for.
      const message: ToggleMessage = { type: 'toggleTask', text, line: Number(box.dataset['line']), checked: box.checked };
      ctx.postMessage(message);
    },
    true,
  );
}

/**
 * A Markdown cell drawn with native components from the core's `renderMarkdown` HTML (the same
 * rendering as reports): headings, paragraphs, lists, task lists with real checkboxes, quotes,
 * tables, code blocks, inline code, emphasis and links. No WebView.
 */
import { renderMarkdown } from '@md-runbook/core';
import { Fragment, ReactNode, useMemo } from 'react';
import { Linking, Pressable, ScrollView, Text, TextStyle, View } from 'react-native';
import { Codicon } from '../ui/Codicon';
import { Palette, mono, themedStyles, usePalette } from '../theme';
import { HtmlElement, HtmlNode, parseHtml, textOf } from './html';

const INLINE = new Set(['strong', 'em', 'del', 'code', 'a', 'br', 'span', 'b', 'i', 'input']);

export interface MarkdownViewProps {
  markdown: string;
  testID?: string;
  /** Number of task boxes before this cell in the runbook, so box k here is item `firstTask + k`. */
  firstTask?: number;
  /** A box was tapped (absent: boxes are read-only). */
  onToggleTask?(index: number): void;
}

export function MarkdownView({ markdown, testID, firstTask = 0, onToggleTask }: MarkdownViewProps) {
  const nodes = useMemo(() => parseHtml(renderMarkdown(markdown)), [markdown]);
  const styles = useStyles();
  const c = usePalette();
  // Boxes are numbered in document order while drawing (a fresh counter each render).
  const ctx: Ctx = { styles, c, task: firstTask, onToggleTask };
  return (
    <View testID={testID} style={styles.root}>
      {blocks(nodes, ctx, 'b')}
    </View>
  );
}

/** Number of task boxes `renderMarkdown` draws for this Markdown. */
export function countTaskBoxes(markdown: string): number {
  return (renderMarkdown(markdown).match(/<input type="checkbox"/g) ?? []).length;
}

interface Ctx {
  styles: Styles;
  c: Palette;
  task: number;
  onToggleTask?: (index: number) => void;
}

const isInline = (n: HtmlNode): boolean => typeof n === 'string' || INLINE.has(n.tag);

/** Block children: runs of inline nodes become one Text, block elements their own views. */
function blocks(nodes: readonly HtmlNode[], ctx: Ctx, key: string, textStyle?: TextStyle): ReactNode[] {
  const out: ReactNode[] = [];
  let run: HtmlNode[] = [];
  const flush = (): void => {
    // Whitespace between block tags is not text.
    if (run.some((n) => typeof n !== 'string' || n.trim() !== '')) {
      const k = `${key}.${out.length}`;
      out.push(
        <Text key={k} style={[ctx.styles.text, textStyle]}>
          {inline(trimRun(run), ctx, k)}
        </Text>,
      );
    }
    run = [];
  };
  for (const n of nodes) {
    if (isInline(n) && !(typeof n !== 'string' && n.tag === 'input')) run.push(n);
    else if (typeof n !== 'string' && n.tag === 'input') {
      flush();
      out.push(checkbox(n, ctx, `${key}.${out.length}`));
    } else {
      flush();
      out.push(block(n as HtmlElement, ctx, `${key}.${out.length}`));
    }
  }
  flush();
  return out;
}

/** Leading and trailing newlines of a run (from the HTML's line breaks) are not shown. */
function trimRun(run: HtmlNode[]): HtmlNode[] {
  const r = [...run];
  if (typeof r[0] === 'string') r[0] = r[0].replace(/^\s+/, '');
  const last = r.length - 1;
  if (typeof r[last] === 'string') r[last] = (r[last] as string).replace(/\s+$/, '');
  return r;
}

function block(el: HtmlElement, ctx: Ctx, key: string): ReactNode {
  const { styles } = ctx;
  switch (el.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return (
        <Text key={key} accessibilityRole="header" style={[styles.text, styles[el.tag]]}>
          {inline(el.children, ctx, key)}
        </Text>
      );
    case 'p':
      return (
        <Text key={key} style={[styles.text, styles.p]}>
          {inline(trimRun(el.children), ctx, key)}
        </Text>
      );
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {blocks(el.children, ctx, key, styles.quoteText)}
        </View>
      );
    case 'ul':
    case 'ol':
      return list(el, ctx, key);
    case 'table':
      return table(el, ctx, key);
    case 'div':
      if (el.attrs.class === 'code') return codeBlock(el, ctx, key);
      return <View key={key}>{blocks(el.children, ctx, key)}</View>;
    case 'pre':
      return codeBlock(el, ctx, key);
    default:
      return <View key={key}>{blocks(el.children, ctx, key)}</View>;
  }
}

function list(el: HtmlElement, ctx: Ctx, key: string): ReactNode {
  const ordered = el.tag === 'ol';
  let n = ordered ? Number(el.attrs.start ?? '1') || 1 : 1;
  const items = el.children.filter((c): c is HtmlElement => typeof c !== 'string' && c.tag === 'li');
  return (
    <View key={key} style={ctx.styles.list}>
      {items.map((li, i) => {
        const k = `${key}.${i}`;
        const task = li.attrs.class === 'task';
        const box = task ? li.children.find((c): c is HtmlElement => typeof c !== 'string' && c.tag === 'input') : undefined;
        const rest = box ? li.children.filter((c) => c !== box) : li.children;
        const marker = task ? null : <Text style={[ctx.styles.text, ctx.styles.bullet]}>{ordered ? `${n++}.` : '•'}</Text>;
        return (
          <View key={k} style={ctx.styles.item}>
            {box ? checkbox(box, ctx, `${k}.box`) : marker}
            <View style={ctx.styles.itemBody}>{blocks(rest, ctx, k)}</View>
          </View>
        );
      })}
    </View>
  );
}

function checkbox(input: HtmlElement, ctx: Ctx, key: string): ReactNode {
  const index = ctx.task++;
  const checked = 'checked' in input.attrs;
  const toggle = ctx.onToggleTask;
  return (
    <Pressable
      key={key}
      testID={`task-${index}`}
      role="checkbox"
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !toggle }}
      aria-checked={checked}
      disabled={!toggle}
      hitSlop={8}
      onPress={() => toggle?.(index)}
      style={[ctx.styles.box, checked && { backgroundColor: ctx.c.accent, borderColor: ctx.c.accent }]}
    >
      {checked ? <Codicon name="check" size={12} color={ctx.c.onAccent} /> : null}
    </Pressable>
  );
}

function table(el: HtmlElement, ctx: Ctx, key: string): ReactNode {
  const rows: { head: boolean; cells: HtmlElement[] }[] = [];
  const walk = (n: HtmlNode, head: boolean): void => {
    if (typeof n === 'string') return;
    if (n.tag === 'tr') rows.push({ head, cells: n.children.filter((c): c is HtmlElement => typeof c !== 'string') });
    else n.children.forEach((c) => walk(c, head || n.tag === 'thead'));
  };
  walk(el, false);
  return (
    <ScrollView key={key} horizontal style={ctx.styles.tableScroll}>
      <View style={ctx.styles.table}>
        {rows.map((r, i) => (
          <View key={i} style={[ctx.styles.row, r.head && ctx.styles.headRow]}>
            {r.cells.map((cell, j) => (
              <View key={j} style={ctx.styles.cell}>
                <Text style={[ctx.styles.text, r.head && ctx.styles.strong]}>{inline(cell.children, ctx, `${key}.${i}.${j}`)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function codeBlock(el: HtmlElement, ctx: Ctx, key: string): ReactNode {
  const find = (n: HtmlNode, tag: string): HtmlElement | undefined =>
    typeof n === 'string' ? undefined : n.tag === tag ? n : n.children.map((c) => find(c, tag)).find(Boolean);
  const lang = find(el, 'span');
  const code = find(el, 'code') ?? el;
  return (
    <View key={key} style={ctx.styles.codeBlock}>
      {lang ? <Text style={ctx.styles.codeLang}>{textOf(lang)}</Text> : null}
      <ScrollView horizontal>
        <Text style={ctx.styles.code} selectable>
          {textOf(code)}
        </Text>
      </ScrollView>
    </View>
  );
}

function inline(nodes: readonly HtmlNode[], ctx: Ctx, key: string): ReactNode[] {
  const { styles } = ctx;
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    if (typeof n === 'string') return <Fragment key={k}>{n.replace(/\n/g, ' ')}</Fragment>;
    const kids = inline(n.children, ctx, k);
    switch (n.tag) {
      case 'strong':
      case 'b':
        return (
          <Text key={k} style={styles.strong}>
            {kids}
          </Text>
        );
      case 'em':
      case 'i':
        return (
          <Text key={k} style={styles.em}>
            {kids}
          </Text>
        );
      case 'del':
        return (
          <Text key={k} style={styles.del}>
            {kids}
          </Text>
        );
      case 'code':
        return (
          <Text key={k} style={styles.inlineCode}>
            {textOf(n)}
          </Text>
        );
      case 'br':
        return <Fragment key={k}>{'\n'}</Fragment>;
      case 'a': {
        const href = n.attrs.href ?? '';
        // safeUrl already kept only http(s), mailto and relative links; relative ones go nowhere here.
        const external = /^(https?|mailto):/i.test(href);
        return (
          <Text
            key={k}
            accessibilityRole="link"
            style={styles.link}
            onPress={external ? () => void Linking.openURL(href).catch(() => undefined) : undefined}
          >
            {kids}
          </Text>
        );
      }
      default:
        return <Fragment key={k}>{kids}</Fragment>;
    }
  });
}

type Styles = ReturnType<typeof useStyles>;

const useStyles = themedStyles((c) => ({
  root: { gap: 8 },
  text: { fontSize: 15, lineHeight: 22, color: c.text },
  p: {},
  h1: { fontSize: 26, lineHeight: 32, fontWeight: '600', marginTop: 8 },
  h2: { fontSize: 21, lineHeight: 28, fontWeight: '600', marginTop: 6 },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: '600', marginTop: 4 },
  h4: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  h5: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  h6: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: c.muted },
  strong: { fontWeight: '600' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: mono, fontSize: 13, backgroundColor: c.inlineCode, color: c.text },
  link: { color: c.link, textDecorationLine: 'underline' },
  hr: { height: 1, backgroundColor: c.border, marginVertical: 6 },
  quote: { borderLeftWidth: 4, borderColor: c.quoteBorder, paddingLeft: 12, gap: 6 },
  quoteText: { color: c.muted },
  list: { gap: 4 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  itemBody: { flex: 1, gap: 4 },
  bullet: { minWidth: 18, textAlign: 'right', color: c.muted },
  box: {
    width: 18,
    height: 18,
    marginTop: 2,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: c.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: 4 },
  row: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.border },
  headRow: { borderTopWidth: 0, backgroundColor: c.codeBackground },
  cell: { minWidth: 96, maxWidth: 260, paddingVertical: 6, paddingHorizontal: 10 },
  codeBlock: { backgroundColor: c.codeBackground, borderRadius: 4, padding: 10, gap: 4 },
  codeLang: { fontSize: 11, color: c.muted },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: c.text },
}));

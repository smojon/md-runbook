/** A rendered host element, as Testing Library returns it: its props and its rendered children. */
interface HostNode {
  props: { value?: unknown };
  children: readonly (HostNode | string)[];
}

const textOf = (n: HostNode | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

/**
 * The text of a text input: its value, or, highlighted (ui/RunbookTextInput.tsx), the text of
 * its <Text> children.
 */
export function inputText(el: unknown): string {
  const n = el as HostNode;
  return typeof n.props.value === 'string' ? n.props.value : n.children.map(textOf).join('');
}

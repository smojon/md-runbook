/**
 * The runbook toolbar's Run, Values, Assistant, Share and Help lists, read from the menus in
 * package.json (the same ones the toolbar's ⋯ shows as submenus). VS Code draws an extension's
 * submenu in the notebook toolbar as a bare icon, so the toolbar has buttons that open these as
 * lists instead. No vscode import: unit-tested.
 */

export interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}
export interface Contributes {
  commands: { command: string; title: string; icon?: unknown }[];
  menus: Record<string, MenuEntry[]>;
}
export interface MenuCommand {
  command: string;
  title: string;
  /** A codicon name, e.g. "debug-continue". */
  icon?: string;
}

/**
 * Whether a when clause holds, for the forms our menus use: `a && b`, `a || b`, `key`, `!key`,
 * `key == value`, `key != value`. Anything else throws (the menus test keeps the menus within this).
 */
export function whenHolds(expr: string | undefined, value: (key: string) => unknown): boolean {
  if (!expr?.trim()) return true;
  return expr.split('||').some((alt) =>
    alt.split('&&').every((term) => {
      const t = term.trim();
      const m = /^([\w.-]+)\s*(==|!=)\s*'?([\w.-]*)'?$/.exec(t);
      if (m) return (String(value(m[1]!) ?? '') === m[3]) === (m[2] === '==');
      const k = /^(!?)([\w.-]+)$/.exec(t);
      if (k) return !!value(k[2]!) !== (k[1] === '!');
      throw new Error(`unsupported when clause: ${t}`);
    }),
  );
}

/** The commands of a menu that show now, in their groups (in menu order), for a list. */
export function menuSections(c: Contributes, menu: string, value: (key: string) => unknown): MenuCommand[][] {
  const byId = new Map(c.commands.map((x) => [x.command, x]));
  const order = (e: MenuEntry): [string, number] => {
    const [g = '', n = '0'] = (e.group ?? '').split('@');
    return [g, Number(n)];
  };
  const entries = (c.menus[menu] ?? [])
    .filter((e) => e.command && byId.has(e.command) && whenHolds(e.when, value))
    .sort((a, b) => {
      const [ga, na] = order(a);
      const [gb, nb] = order(b);
      return ga === gb ? na - nb : ga < gb ? -1 : 1;
    });
  const sections = new Map<string, MenuCommand[]>();
  for (const e of entries) {
    const cmd = byId.get(e.command!)!;
    const icon = typeof cmd.icon === 'string' ? /^\$\(([\w-]+)\)$/.exec(cmd.icon)?.[1] : undefined;
    const group = order(e)[0];
    if (!sections.has(group)) sections.set(group, []);
    sections.get(group)!.push({ command: cmd.command, title: cmd.title, ...(icon ? { icon } : {}) });
  }
  return [...sections.values()];
}

/**
 * Every command has a visible place, so new users find it without the command palette: the
 * runbook toolbar (its buttons and dropdowns), a cell's menus, the editor's context menu, the
 * explorer. The few that live elsewhere are listed with where they are.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

interface MenuItem {
  command?: string;
  submenu?: string;
}
interface Pkg {
  contributes: { commands: { command: string; title: string }[]; menus: Record<string, MenuItem[]>; submenus?: { id: string }[] };
}
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as Pkg;
const { commands, menus, submenus = [] } = pkg.contributes;

/** Shown somewhere other than a contributed menu. */
const ELSEWHERE: Record<string, string> = {
  'mdRunbook.runCellInEditor': 'CodeLens ▶ Run above a block in the text editor',
  'mdRunbook.runCellsBelowInEditor': 'CodeLens ▶ Run Below in the text editor',
  'mdRunbook.toggleSessionMode': 'the toolbar Session: on/off button and Run ▸ Session…',
  'mdRunbook.runLine': 'Ctrl+Alt+Enter; Run Selection and Run This Line are in the context menu',
  'mdRunbook.runLineAt': 'the ▷ button on each line',
  'mdRunbook.toggleLineCheck': 'the check box on each line',
  'mdRunbook.ai.explainLine': 'the line hover (with an AI provider)',
  'mdRunbook.runFromLineAt': 'the line hover',
  'mdRunbook.stepFromLineAt': 'the line hover',
  'mdRunbook.toggleBreakpointAt': 'the line hover (Breakpoint)',
  'mdRunbook.copyLineAt': 'the line hover',
  'mdRunbook.runToLineAt': 'the line hover',
};

describe('menus', () => {
  it('every command is in a menu, or listed with where else it shows', () => {
    const shown = new Set<string>();
    for (const [menu, items] of Object.entries(menus)) {
      if (menu === 'commandPalette') continue;
      for (const i of items) if (i.command) shown.add(i.command);
    }
    const hidden = commands.map((c) => c.command).filter((c) => !shown.has(c) && !(c in ELSEWHERE));
    assert.deepEqual(hidden, [], 'give these a menu place (the toolbar dropdowns are the default)');
  });

  it('menus only name commands and submenus that exist, and every submenu is placed and filled', () => {
    const ids = new Set(commands.map((c) => c.command));
    const subs = new Set(submenus.map((s) => s.id));
    for (const [menu, items] of Object.entries(menus)) {
      for (const i of items) {
        if (i.command) assert.ok(ids.has(i.command) || i.command.startsWith('notebook.'), `${menu}: unknown command ${i.command}`);
        if (i.submenu) assert.ok(subs.has(i.submenu), `${menu}: unknown submenu ${i.submenu}`);
      }
    }
    for (const s of subs) {
      assert.ok((menus[s] ?? []).length > 0, `submenu ${s} is empty`);
      assert.ok(Object.values(menus).some((items) => items.some((i) => i.submenu === s)), `submenu ${s} is not placed`);
    }
  });
});

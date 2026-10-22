/** The runbook toolbar's Run, Values, Assistant, Share and Help buttons: each opens its menu as a list. */

import * as vscode from 'vscode';
import { contextValue } from './contextKeys';
import { Contributes, menuSections } from './toolbarMenu';

const MENUS = ['run', 'values', 'assistant', 'share', 'help'];

export function registerToolbarButtons(context: vscode.ExtensionContext): void {
  const contributes = (context.extension.packageJSON as { contributes: Contributes }).contributes;
  const value = (key: string): unknown => {
    if (key === 'notebookType') return vscode.window.activeNotebookEditor?.notebook.notebookType;
    if (key.startsWith('config.')) return vscode.workspace.getConfiguration().get(key.slice('config.'.length));
    return contextValue(key);
  };
  for (const name of MENUS) {
    // The toolbar passes its notebook as the arguments; the chosen command gets them too, as it
    // would from a submenu.
    const open = (...args: unknown[]): void => {
      type Item = vscode.QuickPickItem & { command?: string };
      const items: Item[] = [];
      for (const section of menuSections(contributes, `mdRunbook.toolbar.${name}`, value)) {
        if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        for (const c of section) items.push({ label: c.icon ? `$(${c.icon}) ${c.title}` : c.title, command: c.command });
      }
      const pick = vscode.window.createQuickPick<Item>();
      pick.items = items;
      pick.placeholder = `${name[0]!.toUpperCase()}${name.slice(1)}: pick an action, or type to filter`;
      pick.onDidAccept(() => {
        const command = pick.selectedItems[0]?.command;
        pick.hide();
        if (command) void vscode.commands.executeCommand(command, ...args);
      });
      pick.onDidHide(() => pick.dispose());
      pick.show();
    };
    context.subscriptions.push(vscode.commands.registerCommand(`mdRunbook.menu.${name}`, open));
  }
}

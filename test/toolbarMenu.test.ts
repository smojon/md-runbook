import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Contributes, menuSections, whenHolds } from '../src/toolbarMenu';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: Contributes };
const MENUS = ['run', 'values', 'assistant', 'share', 'help'];

describe('toolbar lists', () => {
  it('when clauses: and, or, not, == and !=', () => {
    const ctx: Record<string, unknown> = { notebookType: 'md-runbook', 'config.mdRunbook.ai.provider': 'off', 'mdRunbook.hasProposals': false };
    const v = (k: string): unknown => ctx[k];
    assert.ok(whenHolds(undefined, v));
    assert.ok(whenHolds('notebookType == md-runbook', v));
    assert.ok(whenHolds("notebookType == 'md-runbook'", v));
    assert.ok(!whenHolds('notebookType == md-runbook && config.mdRunbook.ai.provider != off', v));
    assert.ok(!whenHolds('mdRunbook.hasProposals', v));
    assert.ok(whenHolds('!mdRunbook.hasProposals', v));
    assert.ok(whenHolds('mdRunbook.hasProposals || notebookType == md-runbook', v));
    assert.ok(whenHolds('unset != off', v));
    assert.throws(() => whenHolds('resourceFilename =~ /x/', v));
  });

  it("every toolbar menu's when clauses are ones the lists can read", () => {
    for (const n of MENUS) for (const e of pkg.contributes.menus[`mdRunbook.toolbar.${n}`] ?? []) whenHolds(e.when, () => undefined);
  });

  it('a list has the menu commands in group order, with icons, hiding what the context hides', () => {
    const ctx: Record<string, unknown> = { notebookType: 'md-runbook', 'config.mdRunbook.ai.provider': 'off' };
    const assistant = menuSections(pkg.contributes, 'mdRunbook.toolbar.assistant', (k) => ctx[k]);
    const ids = assistant.map((s) => s.map((c) => c.command));
    assert.deepEqual(ids, [
      ['mdRunbook.copyForAi', 'mdRunbook.pasteAiProposal', 'mdRunbook.checkForLeaks'],
      ['mdRunbook.ai.setAnthropicKey', 'mdRunbook.ai.clearAnthropicKey'],
    ]);
    assert.deepEqual(assistant[0]![0], { command: 'mdRunbook.copyForAi', title: 'Copy for AI', icon: 'sparkle' });
    ctx['config.mdRunbook.ai.provider'] = 'anthropic';
    ctx['mdRunbook.hasProposals'] = true;
    assert.equal(menuSections(pkg.contributes, 'mdRunbook.toolbar.assistant', (k) => ctx[k]).length, 4);
  });

  it('every list has a toolbar button, and every menu is also in the toolbar ⋯', () => {
    const toolbar = pkg.contributes.menus['notebook/toolbar']!;
    for (const n of MENUS) {
      assert.ok(menuSections(pkg.contributes, `mdRunbook.toolbar.${n}`, () => true).length > 0, n);
      assert.ok(toolbar.some((e) => e.command === `mdRunbook.menu.${n}` && e.group?.startsWith('navigation')), `button ${n}`);
      assert.ok(toolbar.some((e) => e.submenu === `mdRunbook.toolbar.${n}` && !e.group?.startsWith('navigation')), `⋯ ${n}`);
    }
  });
});

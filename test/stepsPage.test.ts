import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { stepsPage } from '../src/stepsPage';

describe('Steps view page', () => {
  const html = stepsPage({ cspSource: 'vscode-resource:' } as vscode.Webview, { toString: () => 'codicon.css' } as vscode.Uri);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

  it('has a script that parses (an escape in the template string would break it)', () => {
    assert.ok(script.length > 0);
    assert.doesNotThrow(() => new Function(script));
  });

  it('keeps the script nonce in the CSP', () => {
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    assert.ok(nonce && html.includes(`script-src 'nonce-${nonce}'`));
  });
});

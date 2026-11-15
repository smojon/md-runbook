/** The text editor's CodeLens runs (src/editorRunOptions.ts): front matter and fence options, as in the notebook. */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { editorRunOptions } from '../src/editorRunOptions';

describe('CodeLens run options', () => {
  const base = path.resolve('runbooks');
  const cfg = { timeoutMs: 60_000, env: { A: 'settings' }, shell: {} };
  const doc = '---\ncwd: ../infra\ntimeout: 300\nshell: zsh\n---\n\n```bash\necho hi\n```\n';

  it('applies the front matter cwd: and timeout:, then the fence options', () => {
    const o = editorRunOptions('bash', base, cfg, doc, true);
    assert.equal(o.cwd, path.resolve(base, '../infra'));
    assert.equal(o.timeoutMs, 300_000);
    const own = editorRunOptions('bash cwd=sub timeout=5 env.A=cell', base, cfg, doc, true);
    assert.equal(own.cwd, path.resolve(base, 'sub'));
    assert.equal(own.timeoutMs, 5_000);
    assert.equal(own.env.A, 'cell');
  });

  it('with mdRunbook.cellOptions.enabled off, applies neither the front matter cwd:/timeout: nor the fence options', () => {
    const o = editorRunOptions('bash cwd=sub timeout=5 env.A=cell skip', base, cfg, doc, false);
    assert.equal(o.cwd, base);
    assert.equal(o.timeoutMs, 60_000);
    assert.deepEqual(o.env, { A: 'settings' });
    assert.equal(o.skip, false);
    assert.equal(o.error, undefined);
  });

  it("keeps the runbook's shell: either way, as the notebook does", () => {
    const shell = parseFrontMatter(doc)?.shell;
    assert.ok(shell);
    assert.deepEqual(editorRunOptions('bash', base, cfg, doc, false).shell, { runbook: shell });
    assert.deepEqual(editorRunOptions('bash', base, cfg, doc, true).shell, { runbook: shell });
  });
});

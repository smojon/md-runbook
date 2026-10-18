import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parse } from '../src/core';
import { approvedInfo, proposalOf, proposedInfo, withInfo } from '../src/core/proposal';
import { buildAiContext, depseudonymize, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../src/core/aiContext';
import type { CodeMeta } from '../src/core';

describe('proposal', () => {
  it('reads proposed / approved / none', () => {
    assert.deepEqual(proposalOf('bash proposed by=ai reason="check restarts"'), { state: 'proposed', by: 'ai', reason: 'check restarts' });
    assert.equal(proposalOf('sh approved-by=me approved-at=x by=ai').state, 'approved');
    assert.equal(proposalOf('pwsh timeout=30').state, 'none');
    assert.equal(proposalOf('bash approved-by=me proposed').state, 'proposed');
  });

  it('builds and approves info strings, keeping other tokens', () => {
    const info = proposedInfo('bash', 'claude sonnet', 'check "pods"\nnow');
    assert.equal(info, 'bash proposed by=claude-sonnet reason="check pods now"');
    const approved = approvedInfo(info + ' timeout=30', 'smojon', '2026-10-18T17:20:00+02:00');
    assert.equal(approved, 'bash approved-by=smojon approved-at=2026-10-18T17:20:00+02:00 by=claude-sonnet reason="check pods now" timeout=30');
    assert.equal(proposalOf(approved).state, 'approved');
  });

  it('rewrites the opening fence line keeping indent, fence and EOL', () => {
    const meta = parse('  ~~~~bash proposed by=ai\r\n  echo\r\n  ~~~~\r\n').cells[0]!.meta as CodeMeta;
    const next = withInfo(meta, approvedInfo(meta.info, 'me', 'now'));
    assert.equal(next.open, '  ~~~~bash approved-by=me approved-at=now by=ai\r\n');
  });
});

describe('aiContext baseline', () => {
  it('wraps outputs as untrusted and maps aliases back', () => {
    const md = '# T\n\n```sh\necho hi\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nhi\n```\n<!-- md-runbook:output end -->\n';
    const ctx = buildAiContext(md, { maxOutputLines: 10, maxChars: 10_000, pseudonymize: false });
    assert.ok(ctx.text.includes(`${UNTRUSTED_OPEN}\nhi\n${UNTRUSTED_CLOSE}`));
    assert.equal(depseudonymize('kubectl get pods -n ns-1 on host-12', { forward: { prod: 'ns-1', 'a.b.c': 'host-12', x: 'host-1' } }), 'kubectl get pods -n prod on a.b.c');
  });
});

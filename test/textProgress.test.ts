import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { textProgress } from '@md-runbook/core/textProgress';

const fence = (info: string, body: string, exit?: string): string =>
  '```' + info + '\n' + body + '\n```\n' + (exit ? `<!-- md-runbook:output start exit=${exit} -->\n\`\`\`text\nout\n\`\`\`\n<!-- md-runbook:output end -->\n` : '') + '\n';

describe('textProgress (the app)', () => {
  it('counts code cells by their output, task boxes, host= blocks as steps, os= for the remote system', () => {
    const text =
      '# Deploy\n\n- [x] ticket open\n- [ ] tell the team\n\n' +
      fence('bash', 'echo one', '0') +
      fence('bash host=db', 'echo two', '1') +
      fence('bash', 'echo three') +
      fence('bash os=windows', 'dir') +
      fence('bash os=linux,macos', 'ls');
    const p = textProgress(text);
    // Steps: 2 task boxes, 3 cells, 1 os= group (its linux alternative).
    assert.deepEqual({ total: p.total, done: p.done, failed: p.failed, pending: p.pending, skipped: p.skipped }, { total: 6, done: 2, failed: 1, pending: 3, skipped: 0 });
    assert.equal(p.firstFailed?.step, 4);
    assert.equal(p.firstPending?.step, 2, 'the unticked task box');
    // Resume (cell indexes): the failed host= block, then the pending cells; not the Windows alternative.
    assert.deepEqual(p.resume, [2, 3, 5]);
  });
});

/** The runbook's title and headings: front matter and code blocks skipped. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { headingsOf, runbookTitle } from '@md-runbook/core/title';

describe('runbookTitle', () => {
  it('skips a comment in the front matter and # lines in code blocks', () => {
    const sop = '---\n# Every command runs against this cluster\nkube-context: x\n---\n\n```bash\n# a shell comment\n```\n\n# Synthetic login failing\n';
    assert.equal(runbookTitle(sop), 'Synthetic login failing');
    assert.equal(runbookTitle('---\r\n# only a comment\r\n---\r\n\r\ntext\r\n'), undefined);
    assert.equal(runbookTitle('﻿---\n# c\n---\n# T #\n'), 'T');
    assert.equal(runbookTitle('## not the title\n# C#\n'), 'C#');
    assert.equal(runbookTitle('~~~\n# in tildes\n~~~\n# After\n'), 'After');
  });

  it('headingsOf gives levels and lines', () => {
    assert.deepEqual(headingsOf('# A\ntext\n## B ##\n####### seven\n#no space\n'), [
      { level: 1, text: 'A', line: 0 },
      { level: 2, text: 'B', line: 2 },
    ]);
  });
});

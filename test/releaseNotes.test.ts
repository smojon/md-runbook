import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it } from 'node:test';

// scripts/release-notes.js, from out/test/.
const { notes, unwrap } = require(path.join(__dirname, '..', '..', 'scripts', 'release-notes.js')) as {
  notes: (version: string, text: string) => string;
  unwrap: (text: string) => string;
};

describe('release notes (GitHub turns each line break into a break)', () => {
  it('joins the wrapped lines of a paragraph and of each list item', () => {
    const text = [
      'One line that wraps',
      'onto the next.',
      '',
      '- **Docs:** an item that wraps',
      '  onto the next line',
      '  and another.',
      '- A second item.',
      '  - A sub-item that',
      '    wraps.',
    ].join('\n');
    assert.equal(
      unwrap(text),
      ['One line that wraps onto the next.', '', '- **Docs:** an item that wraps onto the next line and another.', '- A second item.', '  - A sub-item that wraps.'].join('\n'),
    );
  });

  it('leaves code blocks, tables and headings as they are', () => {
    const text = ['Run:', '', '```sh', 'npm install', '  --prefix x', '```', '', '| a | b |', '| - | - |', '', '### Heading', 'text'].join('\n');
    assert.equal(unwrap(text), text);
  });

  it('takes the version section from the CHANGELOG, CRLF too', () => {
    const changelog = '# Changelog\r\n\r\n## Unreleased\r\n\r\n## 0.26.8\r\n\r\nShort\r\nsummary.\r\n\r\n- An item\r\n  that wraps.\r\n\r\n## 0.26.7\r\n\r\nOld.\r\n';
    assert.equal(notes('v0.26.8', changelog), 'Short summary.\n\n- An item that wraps.');
    assert.equal(notes('v9.9.9', changelog), 'Release 9.9.9');
  });
});

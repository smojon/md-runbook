import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CellInput, DEFAULT_WRITE_OPTIONS, WriteOptions, clearOutputBlocks, parse, serialize } from '../src/core';
import { unclosedFenceCloser, writesAsCodeCell } from '../src/core/writer';
import { untouched } from './helpers';

const RAN = '2026-10-18T14:20:00+02:00';

function edit(text: string, fn: (cells: CellInput[]) => void, opts: Partial<WriteOptions> = {}): string {
  const doc = parse(text);
  const cells = untouched(doc);
  fn(cells);
  return serialize(doc.meta, cells, { ...DEFAULT_WRITE_OPTIONS, ...opts });
}

const newOutput = (text: string, exit = '0'): CellInput['output'] => ({ kind: 'new', text, attrs: { exit, ran: RAN } });

describe('outputs on save', () => {
  it('adds an output block right after the code block', () => {
    const out = edit('# T\n\n```sh\necho hi\n```\n\nAfter.\n', (c) => {
      c[1]!.output = newOutput('hi\n');
    });
    assert.equal(
      out,
      '# T\n\n```sh\necho hi\n```\n' +
        `<!-- md-runbook:output start exit=0 ran=${RAN} -->\n` +
        '```text\nhi\n```\n<!-- md-runbook:output end -->\n\nAfter.\n',
    );
  });

  it('replaces an existing block, keeping its gap, and re-parses as an output', () => {
    const src = '```sh\necho a\n```\n\n<!-- md-runbook:output start exit=0 ran=old -->\n```text\nold\n```\n<!-- md-runbook:output end -->\nNext\n';
    const out = edit(src, (c) => {
      c[0]!.output = newOutput('new', '2');
    });
    assert.equal(
      out,
      '```sh\necho a\n```\n\n' + `<!-- md-runbook:output start exit=2 ran=${RAN} -->\n` + '```text\nnew\n```\n<!-- md-runbook:output end -->\nNext\n',
    );
    const re = parse(out);
    assert.equal(re.cells.length, 2);
    assert.deepEqual(re.cells[0]!.output, { text: 'new', attrs: { exit: '2', ran: RAN } });
  });

  it('clearing outputs removes the blocks', () => {
    const src = 'A\n\n```sh\necho a\n```\n<!-- md-runbook:output start exit=0 -->\n```text\na\n```\n<!-- md-runbook:output end -->\n\nB\n';
    const out = edit(src, (c) => {
      for (const cell of c) delete cell.output;
    });
    assert.equal(out, 'A\n\n```sh\necho a\n```\n\nB\n');
  });

  it('uses CRLF for output blocks in CRLF files', () => {
    const out = edit('```sh\r\necho hi\r\n```\r\n', (c) => {
      c[0]!.output = newOutput('a\nb');
    });
    assert.equal(
      out,
      '```sh\r\necho hi\r\n```\r\n' + `<!-- md-runbook:output start exit=0 ran=${RAN} -->\r\n` + '```text\r\na\r\nb\r\n```\r\n<!-- md-runbook:output end -->\r\n',
    );
  });

  it('adds a newline when the code block was the last line without one', () => {
    const out = edit('```sh\necho\n```', (c) => {
      c[0]!.output = newOutput('x');
    });
    assert.ok(out.startsWith('```sh\necho\n```\n<!-- md-runbook:output start'));
    assert.equal(parse(out).cells[0]!.output!.text, 'x');
  });

  it('indents output blocks of indented code blocks', () => {
    const out = edit('1. Step\n\n   ```sh\n   echo\n   ```\n', (c) => {
      c[1]!.output = newOutput('a\n\nb');
    });
    assert.equal(
      out,
      '1. Step\n\n   ```sh\n   echo\n   ```\n' +
        `   <!-- md-runbook:output start exit=0 ran=${RAN} -->\n   \`\`\`text\n   a\n\n   b\n   \`\`\`\n   <!-- md-runbook:output end -->\n`,
    );
    assert.equal(parse(out).cells[1]!.output!.text, 'a\n\nb');
  });

  it('lengthens the output fence when output contains fences', () => {
    const text = '```\ncode\n````\n<!-- md-runbook:output end -->';
    const out = edit('```sh\nx\n```\n', (c) => {
      c[0]!.output = newOutput(text);
    });
    assert.ok(out.includes('`````text\n'));
    const re = parse(out + 'tail\n');
    assert.equal(re.cells[0]!.output!.text, text);
    assert.equal(re.cells[1]!.value, 'tail');
  });

  it('strips ANSI, redacts and truncates new outputs', () => {
    const out = edit(
      '```sh\nx\n```\n',
      (c) => {
        c[0]!.output = newOutput('\u001b[31mred\u001b[0m token=abc\n1\n2\n3\n4\n5\n');
      },
      { maxOutputLines: 4, redact: (s) => s.replace('abc', '[REDACTED]') },
    );
    assert.equal(parse(out).cells[0]!.output!.text, 'red token=[REDACTED]\n1\n… [md-runbook: 2 lines truncated] …\n4\n5');
  });

  it('persistOutputs=false skips new outputs but keeps loaded ones', () => {
    const src = '```sh\na\n```\n<!-- md-runbook:output start exit=0 -->\n```text\na\n```\n<!-- md-runbook:output end -->\n```sh\nb\n```\n';
    const out = edit(
      src,
      (c) => {
        c[1]!.output = newOutput('b');
      },
      { persistOutputs: false },
    );
    assert.equal(out, src);
  });
});

describe('edited and new cells', () => {
  it('rebuilds an edited code cell, keeping fence style and info string', () => {
    const out = edit('Intro\n\n~~~~bash title="x"\necho a\n~~~~\n\nEnd\n', (c) => {
      c[1]!.value = 'echo a\necho b';
    });
    assert.equal(out, 'Intro\n\n~~~~bash title="x"\necho a\necho b\n~~~~\n\nEnd\n');
  });

  it('rebuilds edited cells with CRLF in CRLF files, even if the editor hands back CRLF', () => {
    const out = edit('Text\r\n\r\n```sh\r\necho a\r\n```\r\n', (c) => {
      c[0]!.value = 'Text\r\nmore';
      c[1]!.value = 'echo b\r\necho c';
    });
    assert.equal(out, 'Text\r\nmore\r\n\r\n```sh\r\necho b\r\necho c\r\n```\r\n');
  });

  it('re-indents edited code cells inside lists', () => {
    const out = edit('- item\n\n  ```sh\n  echo a\n  ```\n', (c) => {
      c[1]!.value = 'echo a\n\necho b';
    });
    assert.equal(out, '- item\n\n  ```sh\n  echo a\n\n  echo b\n  ```\n');
  });

  it('lengthens the fence when edited code contains a closing fence', () => {
    const out = edit('```sh\necho\n```\n', (c) => {
      c[0]!.value = "cat <<'EOF'\n```\nEOF";
    });
    assert.equal(out, "````sh\ncat <<'EOF'\n```\nEOF\n````\n");
    assert.equal(parse(out).cells[0]!.value, "cat <<'EOF'\n```\nEOF");
  });

  it('changing the language rewrites only the language word', () => {
    const out = edit('```sh title=x\necho\n```\n', (c) => {
      c[0]!.languageId = 'powershell';
    });
    assert.equal(out, '```pwsh title=x\necho\n```\n');
  });

  it('keeps an edited markup cell without trailing newline at EOF', () => {
    const out = edit('```sh\na\n```\n\nlast', (c) => {
      c[1]!.value = 'last edited';
    });
    assert.equal(out, '```sh\na\n```\n\nlast edited');
  });

  it('undoing an edit restores the original bytes', () => {
    const src = 'A  \n\n```sh   \necho\t\n```  \n';
    const out = edit(src, (c) => {
      c[1]!.value = 'changed';
      c[1]!.value = 'echo\t';
    });
    assert.equal(out, src);
  });

  it('separates new cells with blank lines', () => {
    const out = edit('# Title\n```sh\na\n```\n', (c) => {
      c.splice(1, 0, { kind: 'markup', value: 'New para' });
      c.push({ kind: 'code', value: 'Get-Date', languageId: 'powershell' });
    });
    assert.equal(out, '# Title\n\nNew para\n\n```sh\na\n```\n\n```pwsh\nGet-Date\n```\n');
    // Adjacent markup cells merge into one on reload; code cells stay separate.
    assert.deepEqual(
      parse(out).cells.map((c) => c.kind),
      ['markup', 'code', 'code'],
    );
  });

  it('new cells in an empty document', () => {
    const doc = parse('');
    const out = serialize(doc.meta, [
      { kind: 'markup', value: '# Hi' },
      { kind: 'code', value: 'echo', languageId: 'shellscript' },
    ], DEFAULT_WRITE_OPTIONS);
    assert.equal(out, '# Hi\n\n```bash\necho\n```\n');
  });

  it('deleting cells keeps the rest intact', () => {
    const out = edit('A\n\n```sh\na\n```\n\nB\n\n```sh\nb\n```\n', (c) => {
      c.splice(1, 1);
    });
    assert.equal(out, 'A\n\nB\n\n```sh\nb\n```\n');
  });

  it('moving the last cell (no trailing newline) adds a newline', () => {
    const out = edit('A\n\n```sh\na\n```', (c) => {
      c.reverse();
    });
    assert.equal(out, '```sh\na\n```\nA\n\n');
  });

  it('ignores malformed metadata and treats the cell as new', () => {
    const out = serialize(undefined, [{ kind: 'code', value: 'x', languageId: 'bat', meta: { kind: 'code', bogus: true } }], DEFAULT_WRITE_OPTIONS);
    assert.equal(out, '```cmd\nx\n```\n');
  });

  it('writes the BOM back', () => {
    const out = edit('\uFEFF```sh\na\n```\n', (c) => {
      c[0]!.value = 'b';
    });
    assert.equal(out, '\uFEFF```sh\nb\n```\n');
  });
});

describe('clearOutputBlocks', () => {
  it('removes every output block and nothing else', () => {
    const src = '# T\r\n\r\n```sh\r\na\r\n```\r\n<!-- md-runbook:output start exit=0 -->\r\n```text\r\na\r\n```\r\n<!-- md-runbook:output end -->\r\n\r\n```json\r\n{}\r\n```\r\n<!-- md-runbook:output start -->\r\n```text\r\n```\r\n<!-- md-runbook:output end -->\r\n';
    assert.equal(
      clearOutputBlocks(src),
      '# T\r\n\r\n```sh\r\na\r\n```\r\n\r\n```json\r\n{}\r\n```\r\n<!-- md-runbook:output start -->\r\n```text\r\n```\r\n<!-- md-runbook:output end -->\r\n',
    );
  });

  it('is a no-op without output blocks', () => {
    const src = 'a\n\n```sh\nb\n```';
    assert.equal(clearOutputBlocks(src), src);
  });
});

describe('inserting new cells', () => {
  it('does not add a second blank line before a block that already starts with one', () => {
    const doc = parse('```sh\na\n```\n\nText\n');
    const cells = untouched(doc);
    cells.splice(1, 0, { kind: 'markup', value: 'New' });
    assert.equal(serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS), '```sh\na\n```\n\nNew\n\nText\n');
  });
});


describe('markup cells that leave a fence open', () => {
  const SRC = '# T\n\nIntro\n\n```bash\necho hi\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nhi\n```\n<!-- md-runbook:output end -->\n';

  it('an edited markup cell ending inside a fence gets a closing fence', () => {
    const out = edit(SRC, (c) => {
      c[0]!.value = '# T\n\nIntro\n\n```';
    });
    assert.equal(out, '# T\n\nIntro\n\n```\n```\n\n```bash\necho hi\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nhi\n```\n<!-- md-runbook:output end -->\n');
    const back = parse(out);
    assert.equal(back.cells.filter((c) => c.kind === 'code').length, 1, 'code cell survives');
    assert.equal(back.cells.find((c) => c.kind === 'code')?.output?.text, 'hi');
  });

  it('closes with the opening fence char, length and indent; CRLF kept', () => {
    const doc = parse('Text\r\n\r\n```sh\r\necho\r\n```\r\n');
    const cells = untouched(doc);
    cells[0]!.value = 'Text\n  ~~~~python\n  x = 1';
    assert.equal(serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS), 'Text\r\n  ~~~~python\r\n  x = 1\r\n  ~~~~\r\n\r\n```sh\r\necho\r\n```\r\n');
  });

  it('new markup cells are closed too; balanced fences are left alone', () => {
    const doc = parse('```sh\na\n```\n');
    const cells = untouched(doc);
    cells.push({ kind: 'markup', value: 'x\n````md\n```\nstill open' });
    cells.push({ kind: 'markup', value: '```js\nok()\n```' });
    assert.equal(serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS), '```sh\na\n```\n\nx\n````md\n```\nstill open\n````\n\n```js\nok()\n```\n');
  });

  it('untouched markup with an unclosed fence stays byte-identical', () => {
    const text = '```bash\necho\n```\n\nTail\n```\nnever closed\n';
    assert.equal(serialize(parse(text).meta, untouched(parse(text)), DEFAULT_WRITE_OPTIONS), text);
  });

  it('unclosedFenceCloser', () => {
    assert.equal(unclosedFenceCloser('a\n```'), '```');
    assert.equal(unclosedFenceCloser('```\n```'), '');
    assert.equal(unclosedFenceCloser('~~~\n```\n'), '~~~');
    assert.equal(unclosedFenceCloser('plain'), '');
  });
});

describe('writesAsCodeCell', () => {
  it('only shell languages are written as runnable fences', () => {
    for (const id of ['shellscript', 'powershell', 'bat', 'sh', 'bash', 'pwsh', 'cmd', undefined]) assert.equal(writesAsCodeCell(id), true, String(id));
    for (const id of ['python', 'javascript', 'markdown', 'zsh']) assert.equal(writesAsCodeCell(id), false, id);
  });

  it('agrees with what the parser reads back', () => {
    for (const id of ['shellscript', 'python', 'bat', 'json']) {
      const out = serialize(undefined, [{ kind: 'code', value: 'x', languageId: id }], DEFAULT_WRITE_OPTIONS);
      assert.equal(parse(out).cells.some((c) => c.kind === 'code'), writesAsCodeCell(id), id);
    }
  });
});

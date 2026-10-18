import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatLocalIso, processOutputText, stripAnsi, truncateLines } from '../src/core';

describe('output text processing', () => {
  it('strips ANSI colours, OSC hyperlinks and cursor codes', () => {
    assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007\u001b[2K'), 'red link');
  });

  it('collapses carriage-return progress lines', () => {
    const t = processOutputText('10%\r50%\r100%\r\ndone\r\n', { stripAnsi: true, maxOutputLines: 0 });
    assert.equal(t, '100%\ndone');
  });

  it('keeps ANSI when stripping is off', () => {
    assert.equal(processOutputText('\u001b[31mx', { stripAnsi: false, maxOutputLines: 0 }), '\u001b[31mx');
  });

  it('redacts after stripping ANSI so colour codes cannot hide secrets', () => {
    const t = processOutputText('pass\u001b[0mword=x', {
      stripAnsi: true,
      maxOutputLines: 0,
      redact: (s) => s.replace(/password=\S+/, 'password=[REDACTED]'),
    });
    assert.equal(t, 'password=[REDACTED]');
  });

  it('truncates keeping head and tail', () => {
    const text = Array.from({ length: 10 }, (_, i) => String(i + 1)).join('\n');
    assert.equal(truncateLines(text, 4), '1\n2\n… [md-runbook: 6 lines truncated] …\n9\n10');
    assert.equal(truncateLines(text, 1), '1\n… [md-runbook: 9 lines truncated] …');
    assert.equal(truncateLines(text, 0), text);
    assert.equal(truncateLines(text, 10), text);
  });
});

describe('formatLocalIso', () => {
  it('formats local time with the UTC offset', () => {
    const s = formatLocalIso(new Date(2026, 9, 18, 14, 20, 5));
    assert.match(s, /^2026-10-18T14:20:05[+-]\d\d:\d\d$/);
    // Parsing it back yields the same instant.
    assert.equal(new Date(s).getTime(), new Date(2026, 9, 18, 14, 20, 5).getTime());
  });
});

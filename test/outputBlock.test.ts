import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatDurationAttr, formatLocalIso, processOutputText, stripAnsi, truncateLines } from '../src/core';

describe('output text processing', () => {
  it('strips ANSI colours, OSC hyperlinks and cursor codes', () => {
    assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007\u001b[2K'), 'red link');
  });

  it('strips window titles that hold Windows paths', () => {
    const title = '\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007';
    assert.equal(stripAnsi(`PowerShell 5.1\r\n${title}\\\r\n`), 'PowerShell 5.1\r\n\\\r\n');
    assert.equal(stripAnsi('a\u001b]2;My Title (1)\u001b\\b'), 'ab');
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

describe('formatDurationAttr', () => {
  it('formats seconds with millisecond precision', () => {
    assert.equal(formatDurationAttr(1234), '1.234s');
    assert.equal(formatDurationAttr(0), '0.000s');
    assert.equal(formatDurationAttr(61_005), '61.005s');
    assert.equal(formatDurationAttr(-5), '0.000s');
  });
});

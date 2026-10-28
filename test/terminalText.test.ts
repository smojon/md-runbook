import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { processOutputText } from '@md-runbook/core';
import { STDERR_MARK, markStderr } from '@md-runbook/core/outputColors';
import { applyTerminalControls } from '@md-runbook/core/terminalText';
import { withPythonUtf8 } from '@md-runbook/core/node/execute';
import { processOutput } from '@md-runbook/core/outputBlock';

const ESC = '\u001b';
const saved = (t: string): string => processOutputText(t, { stripAnsi: true, maxOutputLines: 0 });

describe('terminal text: what a terminal shows', () => {
  it('leaves output with nothing to apply exactly as it is', () => {
    const t = `plain\n\ttabbed ${ESC}[31mred${ESC}[0m é ✓ 🙂\n`;
    assert.equal(applyTerminalControls(t), t);
  });

  it('a carriage return overwrites from column 1, as a terminal does', () => {
    assert.equal(applyTerminalControls('10%\r50%\r100%\n'), '100%\n');
    assert.equal(applyTerminalControls('abcdef\rXY\n'), 'XYcdef\n', 'was "XY" before');
    assert.equal(applyTerminalControls('done\r'), 'done');
  });

  it('erases in line (K) and applies backspace', () => {
    assert.equal(applyTerminalControls(`progress 100%\r${ESC}[Kdone\n`), 'done\n');
    assert.equal(applyTerminalControls(`old${ESC}[2K\rnew\n`), 'new\n');
    assert.equal(applyTerminalControls(`abcdef${ESC}[3D${ESC}[1K!\n`), '   !ef\n');
    assert.equal(applyTerminalControls('abc\b\bZ\n'), 'aZc\n', 'backspaces were written into the runbook');
  });

  it('redraws over earlier lines with cursor up (spinners, multi-line progress)', () => {
    const frames = `one\ntwo\n${ESC}[1A\r${ESC}[2Kreplaced\n`;
    assert.equal(applyTerminalControls(frames), 'one\nreplaced\n', 'every frame was kept');
    const bars = `a 10%\nb 10%\n${ESC}[2F${ESC}[Ka 100%\n${ESC}[Kb 100%\n`;
    assert.equal(applyTerminalControls(bars), 'a 100%\nb 100%\n');
    assert.equal(applyTerminalControls(`x\n${ESC}[5Ay\n`), 'y\n', 'never above the first line');
  });

  it('moves to a column, forward, and restores a saved position', () => {
    assert.equal(applyTerminalControls(`ab${ESC}[5Gc\n`), 'ab  c\n');
    assert.equal(applyTerminalControls(`a${ESC}[2Cb\n`), 'a  b\n');
    assert.equal(applyTerminalControls(`${ESC}7start…${ESC}8done \n`), 'done …\n');
    assert.equal(applyTerminalControls(`${ESC}[s....${ESC}[uok\n`), 'ok..\n');
  });

  it('keeps a saved output when the screen is cleared (J 2), and erases below with J 0', () => {
    assert.equal(applyTerminalControls(`kept\n${ESC}[2Jafter\n`), 'kept\nafter\n');
    assert.equal(applyTerminalControls(`a\nb\nc\n${ESC}[2A${ESC}[Jz\n`), 'a\nz\n');
  });

  it('keeps colours and links where they were, and drops other control characters', () => {
    assert.equal(applyTerminalControls(`\r${ESC}[32mok${ESC}[0m\n`), `${ESC}[32mok${ESC}[0m\n`);
    assert.equal(applyTerminalControls(`\r${ESC}]8;;https://x.example\u0007link${ESC}]8;;\u0007\n`), `${ESC}]8;;https://x.example\u0007link${ESC}]8;;\u0007\n`);
    assert.equal(applyTerminalControls(`a\u0007b\u0000c\u007f${ESC}[?25l\r\n`.replace('\r\n', '\r')), 'abc');
  });

  it('keeps one cell per code point', () => {
    assert.equal(applyTerminalControls('🙂🙂\rX\n'), 'X🙂\n');
  });

  it('keeps stderr marks on their line, taking no column', () => {
    const t = `out\r\n${markStderr('err 10%\rerr 100%\n')}`.replace('\r\n', '\n');
    assert.equal(applyTerminalControls(t, STDERR_MARK), `out\n${STDERR_MARK}err 100%\n`);
    const r = processOutput(`out\n${markStderr('e1\rE2\n')}`, { stripAnsi: true, maxOutputLines: 0 });
    assert.deepEqual(r, { text: 'out\nE2', stderr: '2' });
  });
});

describe('terminal text: in the saved output', () => {
  it('a redraw is saved as it ended, and colours are still stripped', () => {
    assert.equal(saved(`${ESC}[32mstep 1${ESC}[0m\n${ESC}[1A${ESC}[2K${ESC}[32mstep 2${ESC}[0m\r\n`), 'step 2');
    assert.equal(saved('10%\r50%\r100%\r\ndone\r\n'), '100%\ndone');
  });

  it('keeps colours when stripAnsi is off, without the cursor movements', () => {
    assert.equal(processOutputText(`${ESC}[31mx${ESC}[0m\r${ESC}[Ky`, { stripAnsi: false, maxOutputLines: 0 }), `${ESC}[0my`);
    assert.equal(processOutputText(`${ESC}[31mx${ESC}[0m`, { stripAnsi: false, maxOutputLines: 0 }), `${ESC}[31mx${ESC}[0m`);
  });
});

describe('Python on Windows writes UTF-8', () => {
  it('sets PYTHONIOENCODING on Windows only, unless an encoding or UTF-8 mode is chosen', () => {
    assert.equal(withPythonUtf8({}, 'win32').PYTHONIOENCODING, 'utf-8');
    assert.equal(withPythonUtf8({}, 'linux').PYTHONIOENCODING, undefined);
    assert.deepEqual(withPythonUtf8({ PythonIoEncoding: 'latin-1' }, 'win32'), { PythonIoEncoding: 'latin-1' });
    assert.deepEqual(withPythonUtf8({ PYTHONUTF8: '0' }, 'win32'), { PYTHONUTF8: '0' });
  });
});

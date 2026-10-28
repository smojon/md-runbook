/**
 * What a terminal would show for a program's output, as text: the cursor movements a program uses
 * to redraw (progress bars, spinners, a status line rewritten in place) are applied instead of
 * kept as text. Before this, the saved output kept every frame of a redraw over several lines,
 * cut a line rewritten with `\r` to what came after it (`abcdef\rXY` gave `XY`, a terminal shows
 * `XYcdef`), and wrote backspaces and other control characters into the runbook.
 *
 * Applied: `\r`, `\b`, `\n` (a pipe's newline also returns to column 1), and the CSI sequences
 * A B C D E F G (cursor up, down, forward, back, next/previous line, column), K (erase in line),
 * J 0/1 (erase below/above; J 2/3, clear screen, is ignored: a saved output keeps what it
 * printed), s/u and ESC 7/8 (save/restore the cursor). Other escape sequences (colours, OSC
 * titles and links) stay where they were, zero-width, for stripAnsi or the display; other
 * control characters are dropped. A tab is kept as one character.
 *
 * `zeroWidth` characters (the stderr marks of outputColors.ts) mark the line they are on and take
 * no column: each output line that had one starts with it.
 */

const CSI_RE = /^\u001b\[([0-9;?]*)([ -/]*)([@-~])/;
const OSC_RE = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/;
const NEEDS_WORK = /[\r\b\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]|\u001b\[[0-9;?]*[ -/]*[A-GJKsu]|\u001b[78]/;

export function applyTerminalControls(text: string, zeroWidth = ''): string {
  // Most output has nothing to apply: leave it exactly as it is.
  if (!NEEDS_WORK.test(text)) return text;
  /** Each line is a list of cells; a cell is its character with the sequences written before it. */
  const lines: string[][] = [[]];
  const marked: boolean[] = [false];
  /** Sequences after a line's last character (a colour reset, a link's end), kept at its end. */
  const tails: string[] = [''];
  /** Zero-width sequences waiting for the next character. */
  let pending = '';
  let row = 0;
  let col = 0;
  let saved: [number, number] = [0, 0];

  const ensure = (r: number): void => {
    while (lines.length <= r) {
      lines.push([]);
      marked.push(false);
      tails.push('');
    }
  };
  const put = (ch: string): void => {
    const line = lines[row]!;
    while (line.length < col) line.push(' ');
    line[col] = pending + ch;
    pending = '';
    col++;
  };
  const num = (params: string, dflt: number): number => {
    const n = parseInt(params.split(';')[0] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '\u001b') {
      const rest = text.slice(i, i + 256);
      const csi = CSI_RE.exec(rest);
      if (csi) {
        const [seq, params, inter, final] = csi as unknown as [string, string, string, string];
        i += seq.length;
        if (inter !== '' || params.startsWith('?')) {
          if (final === 'm') pending += seq; // keep anything else that looks like a colour
          continue; // private modes (cursor on/off, …): nothing to show
        }
        const n = num(params, 1);
        switch (final) {
          case 'A': row = Math.max(0, row - n); break;
          case 'B': row += n; ensure(row); break;
          case 'C': col += n; break;
          case 'D': col = Math.max(0, col - n); break;
          case 'E': row += n; ensure(row); col = 0; break;
          case 'F': row = Math.max(0, row - n); col = 0; break;
          case 'G': col = n - 1; break;
          case 'K': {
            const mode = num(params, 0);
            const line = lines[row]!;
            if (mode === 0) line.length = Math.min(line.length, col);
            else if (mode === 1) for (let k = 0; k <= col && k < line.length; k++) line[k] = ' ';
            else line.length = 0;
            break;
          }
          case 'J': {
            const mode = num(params, 0);
            if (mode === 0) {
              lines[row]!.length = Math.min(lines[row]!.length, col);
              lines.length = row + 1;
              marked.length = row + 1;
              tails.length = row + 1;
            } else if (mode === 1) {
              for (let r = 0; r < row; r++) lines[r] = [];
              for (let k = 0; k <= col && k < lines[row]!.length; k++) lines[row]![k] = ' ';
            }
            break;
          }
          case 's': saved = [row, col]; break;
          case 'u': [row, col] = saved; ensure(row); break;
          default: pending += seq; // colours (m) and anything else: kept, zero-width
        }
        continue;
      }
      const osc = OSC_RE.exec(rest);
      if (osc && osc[0].length > 2) {
        pending += osc[0];
        i += osc[0].length;
        continue;
      }
      const next = text[i + 1];
      if (next === '7') saved = [row, col];
      else if (next === '8') {
        [row, col] = saved;
        ensure(row);
      }
      i += next === undefined ? 1 : 2; // other two-character escapes: nothing to show
      continue;
    }
    i++;
    if (c === '\n') {
      tails[row] += pending;
      pending = '';
      row++;
      ensure(row);
      col = 0;
    } else if (c === '\r') col = 0;
    else if (c === '\b') col = Math.max(0, col - 1);
    else if (zeroWidth !== '' && c === zeroWidth) marked[row] = true;
    else if (c === '\t') put(c);
    else if (c < ' ' || c === '\u007f') continue; // other control characters: not shown
    else if (c >= '\ud800' && c <= '\udbff' && i < text.length) put(c + text[i++]); // one cell per code point
    else put(c);
  }
  tails[row] += pending;
  return lines.map((cells, r) => (marked[r] ? zeroWidth : '') + cells.join('') + tails[r]).join('\n');
}

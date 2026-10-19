/**
 * The commands of a cell for line runs ("logical lines"): one per line, except that a line stays
 * together with what it opens or continues: `\` / backtick / `^` continuations, a trailing `|`
 * or `&&`, open quotes and brackets, here-docs and here-strings, and multi-line blocks
 * (`if`/`for`/`while`/`case`, `{ … }`, `( … )`). Blank and comment-only lines are not commands.
 *
 * This is a light scanner, not a shell parser: it only has to find where a command can end.
 */

import { splitLines } from './lines';
import type { ShellKind } from './shellKind';

export interface LineStep {
  /** First and last physical line of the command (0-based, in the cell). */
  start: number;
  end: number;
  /** The lines as written, without the final line ending. */
  text: string;
}

interface Scanner {
  /** Scan one physical line; returns whether it has code (not only blanks and comments). */
  line(text: string): boolean;
  /** The command is not complete after the lines scanned so far. */
  open(): boolean;
}

const SPACE = /[ \t]/;
const WORD = /[A-Za-z0-9_]/;

/** bash and sh. */
class BashScanner implements Scanner {
  private quote: '' | "'" | '"' | "$'" | '`' = '';
  private readonly stack: string[] = [];
  /** Here-docs started on the current command line, waiting for their body. */
  private readonly heredocs: { word: string; strip: boolean }[] = [];
  private inHeredoc = false;
  private cont = false;

  open(): boolean {
    return this.quote !== '' || this.stack.length > 0 || this.heredocs.length > 0 || this.cont;
  }

  line(text: string): boolean {
    if (this.inHeredoc) {
      const doc = this.heredocs[0]!;
      if ((doc.strip ? text.replace(/^\t+/, '') : text) === doc.word) this.heredocs.shift();
      this.inHeredoc = this.heredocs.length > 0;
      return true;
    }
    this.cont = false;
    let code = this.quote !== '';
    let cmdPos = this.quote === '';
    let tail = '';
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i]!;
      if (this.quote === "'" || this.quote === "$'") {
        if (c === '\\' && this.quote === "$'") i++;
        else if (c === "'") this.quote = '';
        i++;
        continue;
      }
      if (this.quote === '"' || this.quote === '`') {
        if (c === '\\') {
          if (i === n - 1) this.cont = true;
          i++;
        } else if (c === this.quote) this.quote = '';
        i++;
        continue;
      }
      if (SPACE.test(c)) {
        i++;
        continue;
      }
      if (c === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]!))) break;
      code = true;
      if (c === '\\') {
        if (i === n - 1) this.cont = true;
        tail = '';
        cmdPos = false;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        this.quote = c;
      } else if (c === '$' && text[i + 1] === "'") {
        this.quote = "$'";
        i++;
      } else if (c === '<' && text.startsWith('<<', i) && text[i + 2] !== '<') {
        const m = /^<<(-)?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/.exec(text.slice(i));
        if (m) {
          this.heredocs.push({ word: m[2] ?? m[3] ?? m[4] ?? '', strip: m[1] === '-' });
          i += m[0].length;
          tail = 'x';
          cmdPos = false;
          continue;
        }
      } else if (c === '(' || c === ')') {
        // Patterns in a `case` have unbalanced parentheses: they don't count there.
        if (this.top() !== 'case') {
          if (c === '(') this.stack.push('(');
          else if (this.top() === '(') this.stack.pop();
        }
      } else if (c === '{') {
        this.stack.push('{');
      } else if (c === '}') {
        if (this.top() === '{') this.stack.pop();
      } else if (cmdPos && WORD.test(c)) {
        let j = i;
        while (j < n && WORD.test(text[j]!)) j++;
        const word = text.slice(i, j);
        const whole = j === n || /[\s;&|()<>]/.test(text[j]!);
        if (whole && this.keyword(word)) {
          i = j;
          tail = word;
          continue;
        }
        i = j;
        tail = word;
        cmdPos = false;
        continue;
      }
      cmdPos = c === ';' || c === '&' || c === '|' || c === '(' || c === '{' || c === '}' || c === '!';
      tail = (tail + c).slice(-2);
      i++;
    }
    // Code after a trailing operator continues on the next line.
    if (this.quote === '' && (tail.endsWith('|') || tail.endsWith('&&'))) this.cont = true;
    this.inHeredoc = this.heredocs.length > 0;
    return code;
  }

  private top(): string | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Handles a reserved word in command position; returns false for an ordinary word. */
  private keyword(word: string): boolean {
    switch (word) {
      case 'if':
      case 'case':
        this.stack.push(word);
        return true;
      case 'for':
      case 'while':
      case 'until':
      case 'select':
        this.stack.push('loop');
        return true;
      case 'fi':
      case 'esac':
      case 'done': {
        const opener = word === 'fi' ? 'if' : word === 'esac' ? 'case' : 'loop';
        if (this.top() === opener) this.stack.pop();
        return true;
      }
      case 'then':
      case 'do':
      case 'else':
      case 'elif':
      case 'in':
      case 'function':
      case 'time':
        return true;
      default:
        return false;
    }
  }
}

/** PowerShell (Windows PowerShell 5.1 and 7). */
class PwshScanner implements Scanner {
  private quote: '' | "'" | '"' | "@'" | '@"' = '';
  private blockComment = false;
  private depth = 0;
  private cont = false;

  open(): boolean {
    return this.quote !== '' || this.blockComment || this.depth > 0 || this.cont;
  }

  line(text: string): boolean {
    this.cont = false;
    if (this.quote === "@'" || this.quote === '@"') {
      if (text.startsWith(this.quote[1] + '@')) this.quote = '';
      return true;
    }
    let code = this.quote !== '';
    let tail = '';
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i]!;
      if (this.blockComment) {
        if (text.startsWith('#>', i)) {
          this.blockComment = false;
          i += 2;
        } else i++;
        continue;
      }
      if (this.quote === "'") {
        if (c === "'" || c === '‘' || c === '’') {
          if (text[i + 1] === c) i++;
          else this.quote = '';
        }
        i++;
        continue;
      }
      if (this.quote === '"') {
        if (c === '`') i++;
        else if (c === '"') {
          if (text[i + 1] === '"') i++;
          else this.quote = '';
        }
        i++;
        continue;
      }
      if (SPACE.test(c)) {
        i++;
        continue;
      }
      if (text.startsWith('<#', i)) {
        this.blockComment = true;
        i += 2;
        continue;
      }
      if (c === '#') break;
      code = true;
      if (c === '`') {
        if (i === n - 1) this.cont = true;
        tail = '`';
        i += 2;
        continue;
      }
      if ((c === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) && text.slice(i + 2).trim() === '') {
        this.quote = text[i + 1] === "'" ? "@'" : '@"';
        return true;
      }
      if (c === "'" || c === '"' || c === '‘' || c === '’') this.quote = c === '"' ? '"' : "'";
      else if (c === '(' || c === '{' || c === '[') this.depth++;
      else if ((c === ')' || c === '}' || c === ']') && this.depth > 0) this.depth--;
      tail = (tail + c).slice(-4);
      i++;
    }
    if (this.quote === '' && !this.blockComment && /(\||,|(?<![=!<>+\-*/%])=|&&|\|\||-and|-or)$/i.test(tail)) this.cont = true;
    return code;
  }
}

/** cmd.exe batch. */
class CmdScanner implements Scanner {
  private depth = 0;
  private cont = false;

  open(): boolean {
    return this.depth > 0 || this.cont;
  }

  line(text: string): boolean {
    this.cont = false;
    // rem, :: and :labels are not commands on their own.
    if (this.depth === 0 && /^[ \t]*(@?rem([ \t].*)?$|:)/i.test(text)) return false;
    let quoted = false;
    let code = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (!SPACE.test(c)) code = true;
      if (c === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (c === '^') {
        if (i === text.length - 1) this.cont = true;
        i++;
      } else if (c === '(') this.depth++;
      else if (c === ')' && this.depth > 0) this.depth--;
    }
    return code;
  }
}

function scanner(kind: ShellKind): Scanner {
  return kind === 'pwsh' ? new PwshScanner() : kind === 'cmd' ? new CmdScanner() : new BashScanner();
}

/** PowerShell: a line starting with `|` (PowerShell 7) or `else`/`catch`/… continues the command above. */
function continuesAbove(kind: ShellKind, line: string): boolean {
  return kind === 'pwsh' && /^[ \t]*(\||(else|elseif|catch|finally)\b)/i.test(line);
}

/** The cell's commands, in order. */
export function splitSteps(source: string, kind: ShellKind): LineStep[] {
  const lines = splitLines(source);
  const sc = scanner(kind);
  const steps: LineStep[] = [];
  let start: number | undefined;
  const close = (end: number): void => {
    steps.push({ start: start!, end, text: lines.slice(start, end + 1).map((l, k, all) => l.text + (k < all.length - 1 ? l.eol : '')).join('') });
    start = undefined;
  };
  /** Next line that has something on it, for `continuesAbove`. */
  const nextFilled = (i: number): string | undefined => lines.slice(i + 1).find((l) => l.text.trim() !== '')?.text;
  for (let i = 0; i < lines.length; i++) {
    const code = sc.line(lines[i]!.text);
    if (start === undefined) {
      // Blank, a comment, or a block comment still open: not the start of a command.
      if (!code) continue;
      start = i;
    }
    if (sc.open()) continue;
    const next = nextFilled(i);
    if (next !== undefined && continuesAbove(kind, next)) continue;
    // Trailing blank or comment lines belong to no command.
    close(i);
  }
  if (start !== undefined) {
    let end = lines.length - 1;
    while (end > start && lines[end]!.text.trim() === '') end--;
    close(end);
  }
  return steps;
}

/** The command that `line` (0-based) belongs to, if any. */
export function stepAtLine(steps: readonly LineStep[], line: number): LineStep | undefined {
  return steps.find((s) => s.start <= line && line <= s.end);
}

/** 1-based line range for the `lines=` attribute: `3` or `3-5`. */
export function formatLineRange(start: number, end: number): string {
  return start === end ? String(start + 1) : `${start + 1}-${end + 1}`;
}

/**
 * The lines of several commands for `lines=`: ranges joined by commas, adjacent ones merged
 * (`2,4-6` for the commands on lines 2, 4-5 and 6).
 */
export function formatLineRanges(steps: readonly { start: number; end: number }[]): string {
  const merged: [number, number][] = [];
  for (const s of [...steps].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last[1] + 1) last[1] = Math.max(last[1], s.end);
    else merged.push([s.start, s.end]);
  }
  return merged.map(([a, b]) => formatLineRange(a, b)).join(',');
}

/** What the output shows before a command run on its own: `$ ls -la`, `PS> Get-Date`. */
export function echoCommand(kind: ShellKind, text: string): string {
  const prompt = kind === 'pwsh' ? 'PS> ' : kind === 'cmd' ? '> ' : '$ ';
  return text
    .split(/\r\n|\n|\r/)
    .map((l, i) => (i === 0 ? prompt : ' '.repeat(prompt.length)) + l)
    .join('\n') + '\n';
}

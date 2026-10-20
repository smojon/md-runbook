/**
 * A small syntax highlighter for bash and sh cells, close to VS Code's colours: comments,
 * strings, variables, control keywords, declarations, numbers, operators and the command word
 * of each command. A light scanner (no shell parser): wrong colours are possible, wrong text is
 * not. The tokens of each line, joined, are exactly that line.
 */

export type TokenKind = 'plain' | 'comment' | 'keyword' | 'control' | 'string' | 'variable' | 'number' | 'command' | 'operator';

export interface Token {
  text: string;
  kind: TokenKind;
}

const CONTROL = new Set(
  'if then else elif fi for while until do done case esac in select function return exit break continue time coproc'.split(' '),
);
const DECLARE = new Set('export local readonly declare typeset unset set source alias let eval exec trap shift'.split(' '));
/** After these the next word is a command. */
const COMMAND_START = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', '!', 'exec', 'sudo', 'xargs', 'nohup']);

/** The lines of `source` as tokens. */
export function highlightBash(source: string): Token[][] {
  const lines: Token[][] = [[]];
  const push = (text: string, kind: TokenKind): void => {
    // Tokens never cross a line: split them at line breaks.
    text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part === '') return;
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last && last.kind === kind) last.text += part;
      else line.push({ text: part, kind });
    });
  };

  const s = source;
  let i = 0;
  let expectCommand = true;
  /** After export/local/readonly/declare: NAME=value words are assignments. */
  let declaring = false;
  const heredocs: string[] = [];

  const variableAt = (at: number): number => {
    // Length of a variable reference at `at` (s[at] === '$'), or 0.
    const rest = s.slice(at);
    const m = /^\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-])/.exec(rest);
    return m ? m[0].length : 0;
  };

  const doubleQuoted = (): void => {
    // From the opening quote to the closing one, variables inside coloured as variables.
    let j = i + 1;
    let start = i;
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '$' && variableAt(j) > 0) {
        push(s.slice(start, j), 'string');
        const n = variableAt(j);
        push(s.slice(j, j + n), 'variable');
        j += n;
        start = j;
      } else j++;
    }
    j = Math.min(j + 1, s.length);
    push(s.slice(start, j), 'string');
    i = j;
  };

  while (i < s.length) {
    const ch = s[i]!;

    if (ch === '\n') {
      push('\n', 'plain');
      i++;
      // Here-document bodies: whole lines up to their end word.
      while (heredocs.length > 0) {
        const word = heredocs.shift()!;
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const line = s.slice(i, end < 0 ? s.length : end);
          push(line, line.trim() === word ? 'operator' : 'string');
          i = end < 0 ? s.length : end;
          if (i < s.length) {
            push('\n', 'plain');
            i++;
          }
          if (line.trim() === word) break;
        }
      }
      expectCommand = true;
      declaring = false;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      push(s.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (ch === '#') {
      const end = s.indexOf('\n', i);
      push(s.slice(i, end < 0 ? s.length : end), 'comment');
      i = end < 0 ? s.length : end;
      continue;
    }
    if (ch === '\\') {
      push(s.slice(i, i + 2), 'plain');
      i += 2;
      continue;
    }
    if (ch === "'" || (ch === '$' && s[i + 1] === "'")) {
      const open = ch === '$' ? i + 1 : i;
      let j = open + 1;
      while (j < s.length && s[j] !== "'") j += ch === '$' && s[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, s.length);
      push(s.slice(i, j), 'string');
      i = j;
      expectCommand = false;
      continue;
    }
    if (ch === '"') {
      doubleQuoted();
      expectCommand = false;
      continue;
    }
    if (ch === '$' && s[i + 1] === '(') {
      push('$(', 'operator');
      i += 2;
      expectCommand = true;
      continue;
    }
    if (ch === '$' && variableAt(i) > 0) {
      const n = variableAt(i);
      push(s.slice(i, i + n), 'variable');
      i += n;
      expectCommand = false;
      continue;
    }
    const heredoc = /^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
    if (heredoc) {
      push(heredoc[0], 'operator');
      heredocs.push(heredoc[2]!);
      i += heredoc[0].length;
      continue;
    }
    const op = /^(\|\||&&|;;|\|&|[0-9]*>&[0-9-]*|&>>?|[0-9]*>>?|<<<|<|[|;&(){}])/.exec(s.slice(i));
    if (op) {
      push(op[0], 'operator');
      i += op[0].length;
      expectCommand = /^(\|\||&&|;;|\|&|[|;&({])$/.test(op[0]);
      if (expectCommand) declaring = false;
      continue;
    }

    // A word: up to a blank, an operator character, a quote or a variable.
    let j = i;
    while (j < s.length && !/[\s|;&(){}<>"'`$]/.test(s[j]!)) {
      if (s[j] === '\\') j++;
      j++;
    }
    if (j === i) j = i + 1;
    const word = s.slice(i, j);
    let kind: TokenKind;
    if (CONTROL.has(word)) kind = 'control';
    else if (DECLARE.has(word) && expectCommand) kind = 'keyword';
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && (expectCommand || declaring)) {
      // NAME=value before a command: the name is a variable, the command is still to come.
      const eq = word.indexOf('=');
      push(word.slice(0, eq), 'variable');
      push('=', 'operator');
      if (eq + 1 < word.length) push(word.slice(eq + 1), /^-?\d+(\.\d+)?$/.test(word.slice(eq + 1)) ? 'number' : 'plain');
      i = j;
      continue;
    } else if (expectCommand) kind = 'command';
    else if (/^-?\d+(\.\d+)?$/.test(word)) kind = 'number';
    else kind = 'plain';
    push(word, kind);
    i = j;
    if (kind === 'keyword' && /^(export|local|readonly|declare|typeset)$/.test(word)) declaring = true;
    expectCommand =
      COMMAND_START.has(word) || (kind === 'keyword' && word !== 'export' && word !== 'local' && word !== 'readonly' && word !== 'declare');
  }
  return lines;
}

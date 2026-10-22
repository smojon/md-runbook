/**
 * A cell's output with colours, as in VS Code: stderr lines in red (marked in live output, listed
 * in a saved output's `stderr=`), log levels in their colours, a program's own ANSI colours. The
 * settings under Hosts turn the colours off.
 */
import { STDERR_MARK, parseLineSet, styledSpans } from '@md-runbook/core';
import { Text, TextStyle } from 'react-native';
import { useOutputSettings } from '../settings/store';
import { usePalette } from '../theme';

export function OutputText({ text, stderr, style }: { text: string; stderr?: string; style: TextStyle }) {
  const c = usePalette();
  const s = useOutputSettings();
  const saved = parseLineSet(stderr);
  const lines = text.split('\n');
  return (
    <Text style={style} selectable>
      {lines.map((raw, i) => {
        const marked = raw.includes(STDERR_MARK);
        const line = marked ? raw.split(STDERR_MARK).join('') : raw;
        const spans = styledSpans(line, { levels: s.colorLevels, stderr: s.stderrInRed && (marked || saved.has(i)) });
        const end = i < lines.length - 1 ? '\n' : '';
        if (spans.length === 1 && !spans[0]!.color && !spans[0]!.bold) return spans[0]!.text + end;
        return (
          <Text key={i}>
            {spans.map((sp, j) =>
              sp.color || sp.bold ? (
                <Text key={j} style={{ ...(sp.color ? { color: c.terminal[sp.color] } : {}), ...(sp.bold ? { fontWeight: '700' } : {}) }}>
                  {sp.text}
                </Text>
              ) : (
                sp.text
              ),
            )}
            {end}
          </Text>
        );
      })}
    </Text>
  );
}

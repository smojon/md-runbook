/**
 * Edit Note and Delete Note: a note's ⋯ on the runbook. The note stays as VS Code writes it
 * (core formatNote): its marker and head are kept, only the words change; Delete takes it out
 * after a confirm.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { formatNote, parseNotes } from '@md-runbook/core/incident';
import { Alert } from 'react-native';
import { findNotes, noteParts, withNoteText, withoutNote } from '../runbooks/notes';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings } from '../settings/store';
import { RunbookView } from '../screens/RunbookView';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));

const AT = new Date(2026, 10, 16, 14, 32, 5);
const note = (text: string, milestone?: 'mitigated'): string =>
  formatNote({ at: AT, by: 'ana', ...(milestone ? { milestone } : {}), text });
const RUNBOOK = ['# Failover', '', '```bash', 'make failover', '```', '', note('Called the DBA', 'mitigated'), 'More text.', ''].join('\n');

beforeEach(() => {
  resetRunbooks();
  resetSettings();
});

describe('notes (the logic)', () => {
  it('finds a note with its marker, head and words', () => {
    const [n] = findNotes(RUNBOOK);
    expect(n?.marker).toMatch(/^<!-- md-runbook:note at="?2026-11-16T14:32:05/);
    expect(n?.head).toBe('**14:32 · mitigated · ana:**');
    expect(n?.text).toBe('Called the DBA');
  });

  it('Edit keeps the marker and head, as VS Code reads them', () => {
    const marker = findNotes(RUNBOOK)[0]!.marker;
    const next = withNoteText(RUNBOOK, marker, 'Called the DBA\nfailover approved')!;
    expect(next).toContain(`${marker}\n> **14:32 · mitigated · ana:** Called the DBA\n> failover approved\n\nMore text.`);
    expect(parseNotes(next)).toEqual([
      expect.objectContaining({ by: 'ana', milestone: 'mitigated', text: 'Called the DBA\nfailover approved' }),
    ]);
    // Empty words or a note that isn't there: nothing to write.
    expect(withNoteText(RUNBOOK, marker, '  ')).toBeUndefined();
    expect(withNoteText(RUNBOOK, '<!-- md-runbook:note at=x -->', 'y')).toBeUndefined();
  });

  it('keeps CRLF line ends', () => {
    const crlf = RUNBOOK.replace(/\n/g, '\r\n');
    const marker = findNotes(crlf)[0]!.marker;
    const next = withNoteText(crlf, marker, 'One\ntwo')!;
    expect(next).toContain('> **14:32 · mitigated · ana:** One\r\n> two\r\n\r\nMore text.');
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('Delete takes the note out, with one blank line where it was', () => {
    const text = ['Before.', '', note('First'), '', 'After.', ''].join('\n');
    const marker = findNotes(text)[0]!.marker;
    expect(withoutNote(text, marker)).toBe('Before.\n\nAfter.\n');
    expect(withoutNote('Text.\n', marker)).toBeUndefined();
  });

  it('splits a Markdown cell around its notes', () => {
    const parts = noteParts(['Intro.', '', note('First'), '', 'Outro.'].join('\n'));
    expect(parts.map((p) => p.kind)).toEqual(['markdown', 'note', 'markdown']);
    expect(noteParts('Plain.').map((p) => p.kind)).toEqual(['markdown']);
  });
});

describe('a note’s ⋯ on the runbook', () => {
  const press = async (id: string): Promise<void> => {
    await act(async () => {
      fireEvent.press(screen.getByTestId(id));
    });
  };

  it('Edit Note changes its words in place', async () => {
    const r = addRunbook('failover.md', RUNBOOK);
    await render(<RunbookView id={r.id} />);
    await press('cell-2-note-0-actions');
    await press('action-editNote');
    expect(screen.getByTestId('cell-2-note-0-text').props.value).toBe('Called the DBA');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('cell-2-note-0-text'), 'Called the DBA, failover approved');
    });
    await press('cell-2-note-0-save');
    expect(parseNotes(getRunbook(r.id)!.text)[0]).toEqual(
      expect.objectContaining({ text: 'Called the DBA, failover approved', by: 'ana' }),
    );
    expect(screen.getByTestId('run-notice')).toHaveTextContent('Note saved.');
  });

  it('Delete Note asks first, then takes it out', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = addRunbook('failover.md', RUNBOOK);
    await render(<RunbookView id={r.id} />);
    await press('cell-2-note-0-actions');
    await press('action-deleteNote');
    expect(alert).toHaveBeenCalledWith('Delete this note?', expect.stringContaining('can’t be undone'), expect.any(Array));
    // Cancel: nothing changes.
    expect(parseNotes(getRunbook(r.id)!.text)).toHaveLength(1);
    const buttons = alert.mock.calls[0]![2]!;
    await act(async () => buttons.find((b) => b.text === 'Delete')!.onPress!());
    expect(parseNotes(getRunbook(r.id)!.text)).toHaveLength(0);
    expect(getRunbook(r.id)!.text).toContain('make failover');
    expect(screen.queryByTestId('cell-2-note-0-actions')).toBeNull();
  });
});

import { AppAction, matchActions } from '../ui/ActionsSheet';

const a = (id: string, title: string, hint: string, group: AppAction['group']): AppAction => ({
  id,
  title,
  hint,
  group,
  run: () => undefined,
});
const all = [
  a('resume', 'Resume Run', 'carry on from the failed step', 'run'),
  a('clear', 'Clear All Outputs', 'before sharing it as a template', 'run'),
  a('secrets', 'Secrets', 'tokens and passwords', 'values'),
];

describe('matchActions', () => {
  it('matches every word in the title, the hint or the group, in any case', () => {
    expect(matchActions(all, '').map((x) => x.id)).toEqual(['resume', 'clear', 'secrets']);
    expect(matchActions(all, 'clear out').map((x) => x.id)).toEqual(['clear']);
    expect(matchActions(all, 'FAILED').map((x) => x.id)).toEqual(['resume']);
    expect(matchActions(all, 'values').map((x) => x.id)).toEqual(['secrets']);
    expect(matchActions(all, 'password token').map((x) => x.id)).toEqual(['secrets']);
    expect(matchActions(all, 'nothing like this')).toEqual([]);
  });
});

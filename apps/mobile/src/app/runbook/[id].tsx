import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { useRunbookRoute } from '../../notifications/open';
import { autorunAsked } from '../../runbooks/autorun';
import { RunbookView } from '../../screens/RunbookView';

export default function RunbookRoute() {
  // autorun=1: Run All as Copy opened this copy to run it at once (a link alone can't: see autorun.ts).
  const params = useLocalSearchParams<{ id: string; autorun?: string }>();
  const { id, autorun } = params;
  // A tap on a run's notification comes back to this screen rather than opening another.
  useRunbookRoute(id, params, useIsFocused());
  return <RunbookView id={id} autorun={autorun === '1' && id !== undefined && autorunAsked(id)} />;
}

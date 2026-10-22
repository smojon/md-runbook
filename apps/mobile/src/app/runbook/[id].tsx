import { useLocalSearchParams } from 'expo-router';
import { RunbookView } from '../../screens/RunbookView';

export default function RunbookRoute() {
  // autorun=1: Run All as Copy opened this copy to run it at once.
  const { id, autorun } = useLocalSearchParams<{ id: string; autorun?: string }>();
  return <RunbookView id={id} autorun={autorun === '1'} />;
}

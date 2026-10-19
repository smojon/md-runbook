import { useLocalSearchParams } from 'expo-router';
import { RunbookView } from '../../screens/RunbookView';

export default function RunbookRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RunbookView id={id} />;
}

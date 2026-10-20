import { useLocalSearchParams } from 'expo-router';
import { HostForm } from '../../screens/HostForm';

/** `/hosts/new` adds a host; `/hosts/<id>` edits one. */
export default function HostRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <HostForm id={id === 'new' ? undefined : id} />;
}

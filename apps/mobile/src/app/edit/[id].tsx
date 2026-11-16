import { useLocalSearchParams } from 'expo-router';
import { RunbookEditor } from '../../screens/RunbookEditor';

/** Edit as Text: a runbook's Markdown, its preview, and back to the runbook (from=runbook: it came from there). */
export default function EditRoute() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  return <RunbookEditor id={id} {...(from ? { from } : {})} />;
}

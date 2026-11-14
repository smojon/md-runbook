import { useLocalSearchParams } from 'expo-router';
import { LibraryAdd } from '../screens/LibraryAdd';

/** Add a team library: mdrunbook://library?url=… (a QR code, a link) or the web app's /library?url=… */
export default function LibraryRoute() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  return <LibraryAdd url={Array.isArray(url) ? url[0] : url} />;
}

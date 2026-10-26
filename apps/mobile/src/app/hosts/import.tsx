import { useLocalSearchParams } from 'expo-router';
import { HostsImport } from '../../screens/HostsImport';

/** Import hosts: mdrunbook://hosts/import?h=… (a hosts link or QR code), or pasted. */
export default function HostsImportRoute() {
  const { h } = useLocalSearchParams<{ h?: string }>();
  return <HostsImport packed={h} />;
}

/** Pick a certificate file (`…-cert.pub`) in the browser: the file input, read as text. */
import { getDocumentAsync } from 'expo-document-picker';
import { MAX_CERT_TEXT } from './appCert';

export type CertPick = { kind: 'picked'; text: string } | { kind: 'canceled' } | { kind: 'too-large' };

export async function pickCertificateFile(): Promise<CertPick> {
  const picked = await getDocumentAsync({ type: ['.pub', 'text/plain', '*/*'] });
  if (picked.canceled) return { kind: 'canceled' };
  const file = picked.assets[0]?.file;
  if (!file) return { kind: 'canceled' };
  if (file.size > MAX_CERT_TEXT) return { kind: 'too-large' };
  return { kind: 'picked', text: await file.text() };
}

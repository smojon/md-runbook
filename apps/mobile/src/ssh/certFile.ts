/**
 * Pick a certificate file (`…-cert.pub`) on the phones: a copy through the system picker, read as
 * text. The web has certFile.web.ts.
 */
import { getDocumentAsync } from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import { MAX_CERT_TEXT } from './appCert';

export type CertPick = { kind: 'picked'; text: string } | { kind: 'canceled' } | { kind: 'too-large' };

export async function pickCertificateFile(): Promise<CertPick> {
  // .pub has no registered type everywhere: any file.
  const picked = await getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (picked.canceled) return { kind: 'canceled' };
  const asset = picked.assets[0];
  if (!asset) return { kind: 'canceled' };
  if (asset.size !== undefined && asset.size > MAX_CERT_TEXT) return { kind: 'too-large' };
  return { kind: 'picked', text: await new FsFile(asset.uri).text() };
}

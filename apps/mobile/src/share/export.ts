/**
 * Reports and sharing on the phones, through the system's share sheet (mail, Files, Slack, …):
 * the run report as a PDF (expo-print renders the core's HTML report) or as an HTML file, and the
 * runbook itself with its outputs. The web has export.web.ts.
 */
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';
import type { Runbook } from '../runbooks/store';
import { baseName, cosignRequestMessage, recordJsonText, reportHtml } from './report';

/** A file in the app's cache under `name` (replacing an earlier one), with `text` in it. */
function cacheFile(name: string, text?: string): File {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  if (text !== undefined) {
    f.create();
    f.write(text);
  }
  return f;
}

export async function exportReport(runbook: Runbook, kind: 'html' | 'pdf'): Promise<void> {
  const html = reportHtml(runbook);
  if (kind === 'html') {
    const f = cacheFile(`${baseName(runbook)}.report.html`, html);
    await Sharing.shareAsync(f.uri, { mimeType: 'text/html', UTI: 'public.html', dialogTitle: runbook.title });
    return;
  }
  const { uri } = await Print.printToFileAsync({ html });
  const pdf = cacheFile(`${baseName(runbook)}.pdf`);
  new File(uri).move(pdf);
  await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: runbook.title });
}

/** The runbook as a .md file with its outputs: open it in VS Code, mail it to a colleague. */
export async function shareRunbook(runbook: Runbook): Promise<void> {
  const f = cacheFile(`${baseName(runbook)}.md`, runbook.text);
  await Sharing.shareAsync(f.uri, { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown', dialogTitle: runbook.title });
}

/** Export Run Record (JSON): the timeline and its signature, for audit and ticket tools. */
export async function exportRecordJson(runbook: Runbook): Promise<void> {
  const f = cacheFile(`${baseName(runbook)}.record.json`, recordJsonText(runbook));
  await Sharing.shareAsync(f.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: runbook.title });
}

/**
 * Request Co-signature: a message with a link that opens this signed runbook (in the link,
 * without outputs) on Co-sign Runbook in the reviewer's app, through the share sheet.
 */
export async function requestCosign(runbook: Runbook): Promise<void> {
  await Share.share({ message: cosignRequestMessage(runbook) });
}

/** Share hosts: the list as hosts.json through the share sheet. */
export async function shareHostsFile(json: string): Promise<void> {
  const f = cacheFile('hosts.json', json);
  await Sharing.shareAsync(f.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'hosts.json' });
}

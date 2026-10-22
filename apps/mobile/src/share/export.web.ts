/**
 * Reports and sharing in the browser: the HTML report as a download, the PDF through the
 * browser's print dialog (Save as PDF), and the runbook through the system share sheet where the
 * browser has one, else as a download.
 */
import type { Runbook } from '../runbooks/store';
import { baseName, reportHtml } from './report';

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportReport(runbook: Runbook, kind: 'html' | 'pdf'): Promise<void> {
  const html = reportHtml(runbook);
  if (kind === 'html') return download(`${baseName(runbook)}.report.html`, html, 'text/html');
  const w = window.open('', '_blank');
  if (!w) throw new Error('the browser blocked the print window');
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

export async function shareRunbook(runbook: Runbook): Promise<void> {
  const name = `${baseName(runbook)}.md`;
  const file = new File([runbook.text], name, { type: 'text/markdown' });
  const nav = navigator as Navigator & { canShare?(d: { files: File[] }): boolean };
  if (nav.canShare?.({ files: [file] })) await nav.share({ files: [file], title: runbook.title });
  else download(name, runbook.text, 'text/markdown');
}

/**
 * Reports and sharing in the browser: the HTML report as a download, the PDF through the
 * browser's print dialog (Save as PDF), and the runbook through the system share sheet where the
 * browser has one, else as a download.
 */
import type { Runbook } from '../runbooks/store';
import { baseName, cosignRequestMessage, recordJsonText, reportHtml } from './report';

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const PRINT_FRAME = 'md-runbook-print-frame';

/**
 * Prints the report from a hidden frame that can't run script: `sandbox` without allow-scripts.
 * The report escapes the runbook's text and forbids script itself (its own CSP). The frame is a
 * second wall: even a report that slipped through could not reach the app's window or storage.
 * Before, the report was written into a new same-origin window (threat-model review, 2026-11-27).
 * allow-same-origin lets this page call the frame's print(); allow-modals lets the dialog open.
 */
function printHtml(html: string): Promise<void> {
  // The last report's frame goes only now: a print preview may still read it after print() returns.
  document.getElementById(PRINT_FRAME)?.remove();
  const frame = document.createElement('iframe');
  frame.id = PRINT_FRAME;
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  return new Promise((resolve, reject) => {
    frame.addEventListener(
      'load',
      () => {
        const w = frame.contentWindow;
        if (!w) return reject(new Error('the browser did not open the print frame'));
        w.focus();
        w.print();
        resolve();
      },
      { once: true },
    );
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

export async function exportReport(runbook: Runbook, kind: 'html' | 'pdf'): Promise<void> {
  const html = reportHtml(runbook);
  if (kind === 'html') return download(`${baseName(runbook)}.report.html`, html, 'text/html');
  await printHtml(html);
}

export async function shareRunbook(runbook: Runbook): Promise<void> {
  const name = `${baseName(runbook)}.md`;
  const file = new File([runbook.text], name, { type: 'text/markdown' });
  const nav = navigator as Navigator & { canShare?(d: { files: File[] }): boolean };
  if (nav.canShare?.({ files: [file] })) await nav.share({ files: [file], title: runbook.title });
  else download(name, runbook.text, 'text/markdown');
}

export async function exportRecordJson(runbook: Runbook): Promise<void> {
  download(`${baseName(runbook)}.record.json`, recordJsonText(runbook), 'application/json');
}

export async function requestCosign(runbook: Runbook): Promise<void> {
  const text = cosignRequestMessage(runbook);
  const nav = navigator as Navigator & { share?(d: { text: string }): Promise<void> };
  if (nav.share) await nav.share({ text });
  else await navigator.clipboard.writeText(text);
}

export async function shareHostsFile(json: string): Promise<void> {
  download('hosts.json', json, 'application/json');
}

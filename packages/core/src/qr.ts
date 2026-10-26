/**
 * QR codes for runbook links (core/runbookLink.ts): the module matrix, an SVG of it, and label
 * sheets (one code per machine, from a CSV). No scripts, no external resources: a sheet prints
 * as it is, and the CLI turns it into a PDF.
 */

// A CommonJS module (export =): a plain require works in tsc (no esModuleInterop) and in the app's Babel.
const qrcode: typeof import('qrcode-generator') = require('qrcode-generator');
import { escapeHtml } from './markdown';

/** Most bytes a QR code holds (version 40), by error correction level. */
const CAPACITY = { M: 2331, L: 2953 } as const;

export interface QrMatrix {
  size: number;
  /** Row-major: true for a dark module. */
  dark: boolean[][];
  /** The error correction used: M (15 %), or L (7 %) when the text only fits that way. */
  level: 'M' | 'L';
}

/**
 * The QR code of `text` (byte mode; runbook links are ASCII). Level M where it fits, else L;
 * undefined when the text is too long for any QR code.
 */
export function qrMatrix(text: string): QrMatrix | undefined {
  const bytes = new TextEncoder().encode(text).length;
  const level = bytes <= CAPACITY.M ? 'M' : bytes <= CAPACITY.L ? 'L' : undefined;
  if (!level) return undefined;
  const qr = qrcode(0, level);
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const dark = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => qr.isDark(r, c)));
  return { size, dark, level };
}

export interface QrSvgOptions {
  /** Pixels per module (default 4). */
  scale?: number;
  /** Quiet zone in modules (default 4, the minimum readers expect). */
  margin?: number;
  /** A line of text under the code (a host name, a runbook title). */
  caption?: string;
}

/** The code as an SVG: one path, the dark runs of each row, so it stays small. */
export function qrSvg(m: QrMatrix, opts: QrSvgOptions = {}): string {
  const scale = opts.scale ?? 4;
  const margin = opts.margin ?? 4;
  const side = (m.size + margin * 2) * scale;
  const captionHeight = opts.caption ? Math.max(14, scale * 4) + scale * 2 : 0;
  const d: string[] = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark[r]![c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.dark[r]![c]) c++;
      d.push(`M${(start + margin) * scale} ${(r + margin) * scale}h${(c - start) * scale}v${scale}h-${(c - start) * scale}z`);
    }
  }
  const caption = opts.caption
    ? `<text x="${side / 2}" y="${side + captionHeight / 2}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${Math.max(12, scale * 3.5)}" fill="#000">${escapeHtml(opts.caption)}</text>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side + captionHeight}" width="${side}" height="${side + captionHeight}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d.join('')}"/>${caption}</svg>`
  );
}

/** One label of a sheet: the code's link, and the lines printed under it. */
export interface QrLabel {
  link: string;
  title: string;
  subtitle?: string;
}

/**
 * A printable sheet of labels (A4, three across), each a QR code with its title and subtitle.
 * Self-contained HTML; a label that doesn't fit a QR code is listed as an error instead.
 */
export function qrLabelSheet(heading: string, labels: readonly QrLabel[]): { html: string; tooLong: string[] } {
  const tooLong: string[] = [];
  const cells = labels.map((l) => {
    const m = qrMatrix(l.link);
    if (!m) {
      tooLong.push(l.title);
      return '';
    }
    return (
      `<figure class="label">${qrSvg(m, { scale: 3 })}<figcaption><strong>${escapeHtml(l.title)}</strong>` +
      `${l.subtitle ? `<span>${escapeHtml(l.subtitle)}</span>` : ''}</figcaption></figure>`
    );
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(heading)}</title>
<style>
@page{size:A4;margin:12mm}
body{font-family:system-ui,sans-serif;margin:0;color:#000;background:#fff}
h1{font-size:14px;font-weight:600;margin:0 0 8mm}
.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}
.label{margin:0;padding:4mm;border:1px dashed #999;break-inside:avoid;text-align:center}
.label svg{width:100%;height:auto;max-width:52mm}
figcaption{font-size:11px;line-height:1.35;margin-top:2mm;overflow-wrap:anywhere}
figcaption span{display:block;color:#333}
</style></head><body>
<h1>${escapeHtml(heading)}</h1>
<div class="sheet">
${cells.filter(Boolean).join('\n')}
</div>
</body></html>
`;
  return { html, tooLong };
}

/**
 * Rows of a CSV (comma-separated, double-quoted fields with "" for a quote, CRLF or LF), the
 * first row being the header. Rows are objects by header name; blank lines are skipped.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(names.map((n, k) => [n, (r[k] ?? '').trim()])));
}

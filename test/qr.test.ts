import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import jsQR from 'jsqr';
import { QrMatrix, parseCsv, qrLabelSheet, qrMatrix, qrSvg } from '@md-runbook/core/qr';
import { formatRunbookLink, parseRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';

/** What a phone's reader gets from the code: the matrix drawn as pixels, decoded by jsQR. */
function decode(m: QrMatrix, scale = 4, margin = 4): string | undefined {
  const side = (m.size + margin * 2) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < m.size; r++)
    for (let c = 0; c < m.size; c++) {
      if (!m.dark[r]![c]) continue;
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          const at = (((r + margin) * scale + y) * side + (c + margin) * scale + x) * 4;
          px[at] = px[at + 1] = px[at + 2] = 0;
        }
    }
  return jsQR(px, side, side)?.data;
}

const RUNBOOK = '# Restart the API\n\nCheck first.\n\n```bash\nsystemctl restart ${param:SERVICE}\nsystemctl status ${param:SERVICE}\n```\n';

describe('QR codes for runbook links', () => {
  it('a reader gets back the exact link, with its pin, host and parameters', () => {
    const link = formatRunbookLink({ url: 'https://github.com/o/r/blob/main/restart.md', sha256: runbookDigest(RUNBOOK), host: 'web-1', params: { SERVICE: 'api' } });
    const m = qrMatrix(link)!;
    assert.equal(m.level, 'M');
    assert.equal(decode(m), link);
  });

  it('a runbook carried in the code survives the round trip, so it works with no network', () => {
    const link = formatRunbookLink({ text: RUNBOOK, sha256: runbookDigest(RUNBOOK), params: {} });
    const read = decode(qrMatrix(link)!)!;
    const parsed = parseRunbookLink(read);
    assert.ok(parsed.ok);
    assert.equal(parsed.link.text, RUNBOOK);
  });

  it('switches to level L when M is too small, and refuses what no code can hold', () => {
    assert.equal(qrMatrix('x'.repeat(2331))!.level, 'M');
    assert.equal(qrMatrix('x'.repeat(2332))!.level, 'L');
    assert.equal(qrMatrix('x'.repeat(2954)), undefined);
  });

  it('the SVG is one path on white, with an escaped caption', () => {
    const svg = qrSvg(qrMatrix('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md')!, { caption: 'web <1>' });
    assert.match(svg, /^<svg [^>]*shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"\/><path fill="#000" d="M/);
    assert.equal(svg.match(/<path/g)!.length, 1);
    assert.match(svg, />web &lt;1&gt;<\/text><\/svg>$/);
  });

  it('a label sheet has one code per label and lists the ones too long for a code', () => {
    const { html, tooLong } = qrLabelSheet('Restart <API>', [
      { link: 'mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&host=web-1', title: 'web-1', subtitle: 'Rack 4' },
      { link: 'x'.repeat(4000), title: 'huge' },
    ]);
    assert.equal(html.match(/<figure class="label">/g)!.length, 1);
    assert.deepEqual(tooLong, ['huge']);
    assert.match(html, /<title>Restart &lt;API&gt;<\/title>/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script/);
  });

  it('reads CSV with quotes, a BOM, CRLF and blank lines', () => {
    assert.deepEqual(parseCsv('﻿host,label,p.SERVICE\r\nweb-1,"Rack 4, left",api\r\n\r\nweb-2,"say ""hi""",\n'), [
      { host: 'web-1', label: 'Rack 4, left', 'p.SERVICE': 'api' },
      { host: 'web-2', label: 'say "hi"', 'p.SERVICE': '' },
    ]);
    assert.deepEqual(parseCsv(''), []);
  });
});

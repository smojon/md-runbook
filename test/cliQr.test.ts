import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';
import { parseQrArgs, qrCommand } from '../src/cli/qr';

const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart ${param:SERVICE}\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';

describe('cli: md-runbook qr', () => {
  let dir: string;
  let file: string;
  let lines: string[];
  const out = (l: string): void => void lines.push(l);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-qr-'));
    file = path.join(dir, 'restart.md');
    fs.writeFileSync(file, RUNBOOK);
    lines = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a code carrying the runbook without outputs, with a host and a parameter', async () => {
    assert.equal(await qrCommand([file, '--embed', '--host', 'web-1', '--param', 'SERVICE=api', '--link'], out), 0, lines.join('\n'));
    const svg = fs.readFileSync(path.join(dir, 'restart.qr.svg'), 'utf8');
    assert.match(svg, /^<svg [^>]*><rect [^>]*\/><path fill="#000" d="M/);
    assert.match(svg, />web-1<\/text>/);
    const parsed = parseRunbookLink(lines[0]!);
    assert.ok(parsed.ok);
    assert.equal(parsed.link.host, 'web-1');
    assert.deepEqual(parsed.link.params, { SERVICE: 'api' });
    assert.equal(parsed.link.text, '# Restart the API\n\n```bash\nsystemctl restart ${param:SERVICE}\n```\n');
  });

  it('an address pinned to this file with --pin; web app links with --web-app', async () => {
    assert.equal(await qrCommand([file, '--url', 'https://x.example.net/restart.md', '--pin', '--web-app', 'https://runbook.example.net/open', '--link'], out), 0);
    assert.ok(lines[0]!.startsWith('https://runbook.example.net/open?url=https%3A%2F%2Fx.example.net%2Frestart.md&sha256='));
    const parsed = parseRunbookLink(lines[0]!);
    assert.ok(parsed.ok && parsed.link.sha256 === runbookDigest(RUNBOOK));
  });

  it('a label sheet, one code per CSV row, with the row parameters', async () => {
    const csv = path.join(dir, 'hosts.csv');
    fs.writeFileSync(csv, 'host,label,p.SERVICE\nweb-1,Rack 4,api\nweb-2,"Rack 5, top",\n');
    assert.equal(await qrCommand([file, '--embed', '--labels', csv, '--param', 'SERVICE=web', '--link'], out), 0, lines.join('\n'));
    const html = fs.readFileSync(path.join(dir, 'restart.labels.html'), 'utf8');
    assert.equal(html.match(/<figure class="label">/g)!.length, 2);
    assert.match(html, /Rack 5, top/);
    const one = parseRunbookLink(lines[0]!);
    const two = parseRunbookLink(lines[1]!);
    assert.ok(one.ok && two.ok);
    assert.deepEqual([one.link.host, one.link.params], ['web-1', { SERVICE: 'api' }]);
    assert.deepEqual([two.link.host, two.link.params], ['web-2', { SERVICE: 'web' }], 'an empty cell keeps --param');
  });

  it('refuses what the app would refuse, and usage mistakes', async () => {
    assert.equal(await qrCommand([file, '--embed', '--host', 'bad host'], out), 2);
    assert.equal(await qrCommand([file, '--url', 'http://x.example.net/a.md'], out), 2);
    const csv = path.join(dir, 'no-host.csv');
    fs.writeFileSync(csv, 'name\nweb-1\n');
    assert.equal(await qrCommand([file, '--embed', '--labels', csv], out), 2);
    assert.throws(() => parseQrArgs([file, '--embed', '--url', 'https://a/b.md']), /choose one/);
    assert.throws(() => parseQrArgs([file, '--pin']), /--pin goes with --url/);
    assert.throws(() => parseQrArgs([file, '--param', '1X=a']), /NAME=VALUE/);
    assert.throws(() => parseQrArgs([file, '--web-app', 'http://a/open']), /https/);
  });

  it('says when a runbook is too large to carry in a code', async () => {
    fs.writeFileSync(file, '# Big\n\n' + Array.from({ length: 300 }, () => Math.random().toString(36).repeat(3)).join('\n'));
    assert.equal(await qrCommand([file, '--embed'], out), 1);
  });
});

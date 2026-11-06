import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deflateSync } from 'fflate';
import {
  MAX_LINK_TEXT_BYTES,
  RunbookLink,
  formatRunbookLink,
  linkTrust,
  packText,
  parseRunbookLink,
  runbookDigest,
} from '@md-runbook/core/runbookLink';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';

const manifestOf = (text: string): string => {
  const r = buildManifest(text, { name: 'ops/restart', version: 1, scopes: ['web'], patterns: { SERVICE: '[a-z]+' } });
  if ('errors' in r) throw new Error(r.errors.join('; '));
  return formatManifest(r.manifest);
};

const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart ${param:SERVICE}\n```\n';
const parsed = (s: string): RunbookLink => {
  const r = parseRunbookLink(s);
  assert.ok(r.ok, `${s}: ${r.ok ? '' : r.problem}`);
  return r.link;
};
const problem = (s: string): string | undefined => {
  const r = parseRunbookLink(s);
  return r.ok ? undefined : r.problem;
};

describe('runbook links', () => {
  it('round-trips every field, as an app link and as a web app link', () => {
    const link: RunbookLink = {
      url: 'https://github.com/o/r/blob/main/ops/restart api.md',
      sha256: runbookDigest(RUNBOOK),
      host: 'web-1',
      params: { SERVICE: 'api', NOTE: 'a b&c=d ü' },
      action: 'cosign',
    };
    for (const base of [undefined, 'https://runbook.example.net/open']) {
      const s = formatRunbookLink(link, base);
      assert.deepEqual(parsed(s), link, s);
    }
  });

  it('carries the runbook itself, compressed, and unpacks it exactly', () => {
    const text = `${RUNBOOK}Grüße 🚀\r\n`.repeat(20);
    const s = formatRunbookLink({ text, params: {} });
    assert.ok(s.length < text.length, 'compressed');
    assert.equal(parsed(s).text, text);
  });

  it('keeps reading plain https addresses (links from before runbook links)', () => {
    assert.deepEqual(parsed('https://github.com/o/r/blob/main/a.md'), { url: 'https://github.com/o/r/blob/main/a.md', params: {} });
    // An https link to the web app's /open without a runbook is just an address, too.
    assert.deepEqual(parsed('https://runbook.example.net/open?x=1').url, 'https://runbook.example.net/open?x=1');
  });

  it('refuses what a link must not carry', () => {
    assert.equal(problem('not a link'), 'not-a-link');
    assert.equal(problem('http://example.net/a.md'), 'not-a-link');
    assert.equal(problem('mdrunbook://open?host=web-1'), 'no-runbook');
    assert.equal(problem(`mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&rb=${packText('x')}`), 'both');
    assert.equal(problem('mdrunbook://open?url=http%3A%2F%2Fa%2Fb.md'), 'not-https');
    assert.equal(problem('mdrunbook://open?url=file%3A%2F%2F%2Fetc%2Fpasswd'), 'not-https');
    assert.equal(problem('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&sha256=abc'), 'bad-sha256');
    assert.equal(problem('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&host=a%20b'), 'bad-host');
    assert.equal(problem('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&p.1X=a'), 'bad-param');
    // A parameter value with a newline could smuggle a second command into a shell.
    assert.equal(problem('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&p.X=a%0Arm%20-rf%20%2F'), 'bad-param');
    assert.equal(problem('mdrunbook://open?rb=***'), 'bad-text');
    assert.equal(problem('mdrunbook://open?rb=AAAA'), 'bad-text');
  });

  it('refuses a runbook that unpacks to more than the limit (a small link, a huge text)', () => {
    const bomb = deflateSync(new Uint8Array(MAX_LINK_TEXT_BYTES + 1), { level: 9 });
    const b64 = Buffer.from(bomb).toString('base64url');
    assert.ok(b64.length < 2000);
    assert.equal(problem(`mdrunbook://open?rb=${b64}`), 'too-large');
  });

  it('ignores fields it does not know, and actions other than cosign', () => {
    const l = parsed('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&future=1&action=run');
    assert.deepEqual(l, { url: 'https://a/b.md', params: {} });
  });

  it('pins content: a changed text is a mismatch, the pinned one is pinned', () => {
    const pin = { url: 'https://a/b.md', sha256: runbookDigest(RUNBOOK), params: {} };
    assert.equal(linkTrust(pin, RUNBOOK), 'pinned');
    assert.equal(linkTrust(pin, `﻿${RUNBOOK}`), 'pinned', 'a BOM does not count');
    assert.equal(linkTrust(pin, RUNBOOK.replace('restart', 'stop')), 'mismatch');
    assert.equal(linkTrust({ url: 'https://a/b.md', params: {} }, RUNBOOK), 'unverified');
  });

  it('a runbook carried in the link is never pinned: a forged sticker brings its own pin', () => {
    const carried = { text: RUNBOOK, sha256: runbookDigest(RUNBOOK), params: {} };
    assert.equal(linkTrust(carried, RUNBOOK), 'unverified');
    assert.equal(linkTrust(carried, RUNBOOK.replace('restart', 'stop')), 'mismatch');
  });

  it('a signed runbook is signed while its blocks are unchanged', () => {
    const signed = withSignature(RUNBOOK, {
      signer: 'ops@example.net',
      signed: '2026-10-26',
      manifest: manifestOf(RUNBOOK),
      signature: 'U1NIU0lHAAAAAQ' + 'A'.repeat(150),
    });
    const link = { url: 'https://a/b.md', params: {} };
    assert.equal(linkTrust(link, signed), 'signed');
    assert.equal(linkTrust(link, signed.replace('systemctl restart', 'systemctl stop')), 'unverified');
    // A pin still wins: other content than pinned is refused even when it is signed.
    assert.equal(linkTrust({ ...link, sha256: runbookDigest(RUNBOOK) }, signed), 'mismatch');
  });
});

describe('VS Code links', () => {
  // What VS Code's link handler gets: the query, decoded once (its URI parser percent-decodes it).
  const asHandled = (link: string): string => decodeURIComponent(link.slice(link.indexOf('?') + 1));

  it('survive VS Code decoding the query: plain values as the app link, others carried in link=', async () => {
    const { formatVsCodeLink, parseVsCodeLinkQuery } = await import('@md-runbook/core/runbookLink');
    const plain: RunbookLink = { url: 'https://github.com/acme/ops/blob/main/runbooks/restart api.md', sha256: 'a'.repeat(64), host: 'web-1', params: { SERVICE: 'api' } };
    const tricky: RunbookLink = { url: 'https://x.example.net/r.md?ref=a&b=c', host: 'web-1', params: { Q: 'a+b=c&d#e%41' } };
    const carried: RunbookLink = { text: '# T\n\n```bash\necho hi\n```\n', params: {} };
    const p = formatVsCodeLink(plain);
    assert.match(p, /^vscode:\/\/smojon\.md-runbook\/open\?url=/);
    assert.match(formatVsCodeLink(tricky), /^vscode:\/\/smojon\.md-runbook\/open\?link=mdrunbook%3A%2F%2Fopen%3F/);
    for (const l of [plain, tricky, carried]) {
      const r = parseVsCodeLinkQuery(asHandled(formatVsCodeLink(l)));
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(r.link, l);
    }
    // An alert template appends plain fields to a printed link.
    const r = parseVsCodeLinkQuery(asHandled(`${p}&p.REGION=eu-1`));
    assert.ok(r.ok);
    assert.equal(r.link.params.REGION, 'eu-1');
    assert.equal(parseVsCodeLinkQuery(asHandled('vscode://smojon.md-runbook/open?url=http%3A%2F%2Fx%2Fa.md')).ok, false, 'https only, as in the app');
  });

  it('repoPathCandidates: the file in a clone, longest path first; nothing outside a repository', async () => {
    const { repoPathCandidates, rawRunbookUrl } = await import('@md-runbook/core/runbookLink');
    assert.deepEqual(repoPathCandidates('https://github.com/acme/ops/blob/main/runbooks/restart.md'), ['runbooks/restart.md', 'restart.md']);
    assert.deepEqual(repoPathCandidates('https://github.com/acme/ops/blob/feature/x/runbooks/restart.md'), ['x/runbooks/restart.md', 'runbooks/restart.md', 'restart.md'], 'a branch with a slash');
    assert.deepEqual(repoPathCandidates('https://gitlab.example.net/g/ops/-/blob/main/my%20runbook.md'), ['my runbook.md']);
    assert.deepEqual(repoPathCandidates('https://github.com/acme/ops/blob/main/../../etc/x.md'), [], 'no ..');
    assert.deepEqual(repoPathCandidates('https://x.example.net/restart.md'), []);
    assert.equal(rawRunbookUrl('https://github.com/acme/ops/blob/main/r.md'), 'https://raw.githubusercontent.com/acme/ops/main/r.md');
  });
});

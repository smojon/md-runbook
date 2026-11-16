/** `md-runbook publish` (cli/publish.ts): what it sends to a library server, and what it makes of the answer. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { publishCommand, unpublishCommand } from '../src/cli/publish';
import { publishCheck, removeRefusal } from '../src/libraryClient';
import { libraryPathProblem, nameFitsPath } from '@md-runbook/core/library';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';

describe('md-runbook publish', () => {
  let dir: string;
  let signed: string;
  let unsigned: string;
  const TOKEN = 'upload-token-of-at-least-24-chars';
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-publish-'));
    signed = path.join(dir, 'restart-api.md');
    // A signature block's shape is all the command looks at; the server checks the signature.
    fs.writeFileSync(signed, '# Restart\n\n<!-- md-runbook:signature v1 signer=ops@example.net signed=2026-11-14\nmanifest\nbWQtcnVuYm9vay1tYW5pZmVzdCAx\nsignature\nU1NIU0lH\n-->\n');
    unsigned = path.join(dir, 'plain.md');
    fs.writeFileSync(unsigned, '# Plain\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (argv: string[], answer: { status: number; body: unknown }, env: NodeJS.ProcessEnv = { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }) => {
    const lines: string[] = [];
    const sent: { url: string; init: { method: string; headers: Record<string, string>; body?: string; redirect: string } }[] = [];
    const code = await publishCommand(argv, (l) => lines.push(l), env, async (url, init) => {
      sent.push({ url, init });
      return { status: answer.status, text: async () => JSON.stringify(answer.body) };
    });
    return { code, lines, sent };
  };

  it('POSTs the runbook to /v1/library/runbooks/PATH with the token from the environment only', async () => {
    const r = await run([signed, '--library', 'https://runbooks.example.net/', '--path', 'ops/Restart API.md'], {
      status: 201,
      body: { name: 'ops/restart-api', version: 4, previous: 3, signer: 'ops@example.net' },
    });
    assert.equal(r.code, 0);
    assert.equal(r.sent[0]!.url, 'https://runbooks.example.net/v1/library/runbooks/ops/Restart%20API.md');
    assert.equal(r.sent[0]!.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.sent[0]!.init.redirect, 'error');
    assert.equal(r.sent[0]!.init.body, fs.readFileSync(signed, 'utf8'));
    assert.deepEqual(r.lines, ['✓ published ops/restart-api version 4 at ops/Restart API.md (was version 3), signed by ops@example.net']);
  });

  it('says why the library refused it (exit 1), and refuses to send what is not signed', async () => {
    const r = await run([signed, '--library', 'https://runbooks.example.net'], { status: 409, body: { error: 'restart-api.md: version 3 is not higher than the version published (3)' } });
    assert.equal(r.code, 1);
    assert.match(r.lines[0]!, /✗ restart-api.md: the library refused it \(HTTP 409\): .*not higher/);
    const u = await run([unsigned, '--library', 'https://runbooks.example.net'], { status: 201, body: {} });
    assert.deepEqual([u.code, u.sent.length], [1, 0]);
  });

  it('usage errors: no token, no library, an http address that is not localhost (exit 2, nothing sent)', async () => {
    for (const [argv, env] of [
      [[signed, '--library', 'https://runbooks.example.net'], {}],
      [[signed], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [[signed, '--library', 'http://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [[signed, '--token', TOKEN, '--library', 'https://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
    ] as [string[], NodeJS.ProcessEnv][]) {
      const r = await run(argv, { status: 201, body: {} }, env);
      assert.deepEqual([r.code, r.sent.length], [2, 0], argv.join(' '));
    }
  });
});

describe('md-runbook unpublish', () => {
  const TOKEN = 'upload-token-of-at-least-24-chars';
  const run = async (argv: string[], answer: { status: number; body: unknown }, env: NodeJS.ProcessEnv = { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }) => {
    const lines: string[] = [];
    const sent: { url: string; init: { method: string; headers: Record<string, string>; body?: string; redirect: string } }[] = [];
    const code = await unpublishCommand(argv, (l) => lines.push(l), env, async (url, init) => {
      sent.push({ url, init });
      return { status: answer.status, text: async () => JSON.stringify(answer.body) };
    });
    return { code, lines, sent };
  };

  it('DELETEs /v1/library/runbooks/PATH with the token from the environment, no body', async () => {
    const r = await run(['ops/Restart API.md', '--library', 'https://runbooks.example.net/'], { status: 200, body: { deleted: 'ops/Restart API.md', version: 4 } });
    assert.equal(r.code, 0);
    assert.equal(r.sent[0]!.url, 'https://runbooks.example.net/v1/library/runbooks/ops/Restart%20API.md');
    assert.equal(r.sent[0]!.init.method, 'DELETE');
    assert.equal(r.sent[0]!.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.sent[0]!.init.body, undefined);
    assert.equal(r.sent[0]!.init.redirect, 'error');
    assert.deepEqual(r.lines, ['✓ removed ops/Restart API.md (version 4) from the library']);
  });

  it('says when removing is off (405), the runbook is not there (404) or the token is refused (401): exit 1', async () => {
    const off = await run(['a.md', '--library', 'https://runbooks.example.net'], { status: 405, body: { error: 'deleting is off on this server (LIBRARY_ALLOW_DELETE)' } });
    assert.equal(off.code, 1);
    assert.match(off.lines[0]!, /doesn't allow removing runbooks \(LIBRARY_ALLOW_DELETE is off\)/);
    const gone = await run(['a.md', '--library', 'https://runbooks.example.net'], { status: 404, body: { error: 'a.md is not in the library' } });
    assert.deepEqual([gone.code, gone.lines], [1, ['✗ a.md: a.md is not in the library']]);
    const token = await run(['a.md', '--library', 'https://runbooks.example.net'], { status: 401, body: { error: 'publishing: the token is not one this server accepts' } });
    assert.equal(token.code, 1);
    assert.match(token.lines[0]!, /upload token was refused/);
    const busy = await run(['a.md', '--library', 'https://runbooks.example.net'], { status: 429, body: { error: 'too many requests' } });
    assert.equal(busy.code, 2);
  });

  it('usage errors: no path, a bad path, no token, no library, http (exit 2, nothing sent)', async () => {
    for (const [argv, env] of [
      [['--library', 'https://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [['../etc/passwd.md', '--library', 'https://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [['notes.txt', '--library', 'https://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [['a.md', '--library', 'https://runbooks.example.net'], {}],
      [['a.md'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [['a.md', '--library', 'http://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
      [['a.md', '--path', 'b.md', '--library', 'https://runbooks.example.net'], { MD_RUNBOOK_LIBRARY_TOKEN: TOKEN }],
    ] as [string[], NodeJS.ProcessEnv][]) {
      const r = await run(argv, { status: 200, body: {} }, env);
      assert.deepEqual([r.code, r.sent.length], [2, 0], argv.join(' '));
    }
  });
});

describe('libraryClient', () => {
  it('publishCheck: the library takes runbooks signed as a whole (manifest version 2), unchanged, not expired', () => {
    assert.deepEqual(publishCheck('# Plain\n'), { ok: false, why: 'unsigned' });
    const text = '# Restart\n\n```bash\necho hi\n```\n';
    const built = buildManifest(text, { name: 'restart', version: 3, scopes: [], patterns: {} });
    assert.ok(!('errors' in built));
    const signed = withSignature(text, { signer: 'ops@example.net', signed: '2026-11-14', manifest: formatManifest(built.manifest), signature: 'U1NIU0lH' });
    const ok = publishCheck(signed);
    assert.ok(ok.ok);
    assert.equal(ok.manifest.name, 'restart');
    const changed = publishCheck(signed.replace('echo hi', 'echo bye'));
    assert.deepEqual([changed.ok, !changed.ok && changed.why], [false, 'changed']);
    const prose = publishCheck(signed.replace('# Restart', '# Restart now'));
    assert.deepEqual([prose.ok, !prose.ok && prose.why], [false, 'changed']);
  });

  it('nameFitsPath and libraryPathProblem: the rules of the library server', () => {
    assert.ok(nameFitsPath('restart', 'ops/restart.md'));
    assert.ok(nameFitsPath('ops/restart', 'x/ops/restart.md'));
    assert.ok(!nameFitsPath('ops/restart', 'restart.md'));
    assert.ok(!nameFitsPath('ops/restart', 'staging/restart.md'));
    assert.equal(libraryPathProblem('ops/restart.md'), undefined);
    for (const bad of ['', '/a.md', 'a/../b.md', '.hidden/a.md', 'a.txt', 'a\\b.md', 'a/b/c/d/e/f.md']) assert.ok(libraryPathProblem(bad), bad);
  });

  it('removeRefusal names what to do for 405, 404 and 401', () => {
    assert.match(removeRefusal('a.md', 405, {}), /LIBRARY_ALLOW_DELETE is off/);
    assert.equal(removeRefusal('a.md', 404, { error: 'a.md is not in the library' }), 'a.md is not in the library');
    assert.match(removeRefusal('a.md', 404, { error: 'this server has no library (LIBRARY_DIR)' }), /no library there/);
    assert.match(removeRefusal('a.md', 401, {}), /token was refused/);
  });
});

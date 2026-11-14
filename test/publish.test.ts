/** `md-runbook publish` (cli/publish.ts): what it sends to a library server, and what it makes of the answer. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { publishCommand } from '../src/cli/publish';

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
    const sent: { url: string; init: { method: string; headers: Record<string, string>; body: string; redirect: string } }[] = [];
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

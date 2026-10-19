import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/cli/main';
import { notifyConfig, notifyPayload, notifyText, runLink, sendNotification } from '../src/cli/notify';
import type { StepResult } from '../src/cli/run';

const step = (n: number, status: StepResult['status'], message?: string): StepResult => ({
  step: n,
  line: n * 10,
  language: 'bash',
  title: `step ${n}`,
  status,
  exit: status === 'passed' ? '0' : '1',
  durationMs: 1,
  output: '',
  ...(message ? { message } : {}),
});

describe('notifications', () => {
  it('validates the settings: https only (http for localhost), failure or always', () => {
    assert.equal(notifyConfig(undefined, undefined), undefined);
    assert.equal(notifyConfig('  ', 'always'), undefined);
    assert.deepEqual(notifyConfig('https://hooks.slack.com/services/x', undefined), { url: 'https://hooks.slack.com/services/x', on: 'failure' });
    assert.deepEqual(notifyConfig('http://localhost:9/x', 'ALWAYS'), { url: 'http://localhost:9/x', on: 'always' });
    assert.match(notifyConfig('http://example.com/x', undefined) as string, /must use https/);
    assert.match(notifyConfig('not a url', undefined) as string, /not a valid URL/);
    assert.match(notifyConfig('https://x.test', 'sometimes') as string, /failure" or "always/);
    const p = parseArgs(['run', 'x.md', '--notify', 'https://x.test/h', '--notify-on', 'always']);
    assert.ok(typeof p === 'object' && p.notify === 'https://x.test/h' && p.notifyOn === 'always');
  });

  it('writes a short summary with the failed steps and the run link', () => {
    const text = notifyText(
      'health.md',
      { ok: false, steps: [step(1, 'passed'), step(2, 'failed', 'check failed: the output does not contain "Running"'), step(3, 'not run', 'an earlier step failed')] },
      'https://github.com/o/r/actions/runs/1',
    );
    assert.equal(
      text,
      '✗ health.md: 2 of 3 steps failed or did not run\n• Step 2 (line 20) failed: check failed: the output does not contain "Running"\nhttps://github.com/o/r/actions/runs/1',
    );
    assert.equal(notifyText('h.md', { ok: true, steps: [step(1, 'passed')] }), '✓ h.md: all 1 step passed');
    assert.equal(runLink({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' }), 'https://github.com/o/r/actions/runs/7');
    assert.equal(runLink({}), undefined);
  });

  it('picks the body each service expects', () => {
    assert.deepEqual(notifyPayload('https://hooks.slack.com/services/a', 'hi'), { text: 'hi' });
    assert.deepEqual(notifyPayload('https://discord.com/api/webhooks/1/x', 'hi'), { content: 'hi' });
    assert.deepEqual(notifyPayload('https://chat.googleapis.com/v1/spaces/x/messages?key=k', 'hi'), { text: 'hi' });
    const teams = notifyPayload('https://prod-01.westeurope.logic.azure.com/workflows/x', 'a\nb') as { attachments: { content: { body: { text: string }[] } }[] };
    assert.deepEqual(teams.attachments[0]!.content.body.map((b) => b.text), ['a', 'b']);
  });

  it('posts JSON, and errors never contain the URL', async () => {
    let got: { body: string; type?: string } | undefined;
    let status = 200;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        got = { body, type: req.headers['content-type'] };
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/SECRET-PART`;
    try {
      await sendNotification(url, 'hello');
      assert.deepEqual(got, { body: '{"text":"hello"}', type: 'application/json' });
      status = 404;
      await assert.rejects(sendNotification(url, 'x'), (e: Error) => /HTTP 404/.test(e.message) && !e.message.includes('SECRET'));
    } finally {
      server.close();
    }
    await assert.rejects(sendNotification('http://127.0.0.1:1/SECRET-PART', 'x'), (e: Error) => /request failed/.test(e.message) && !e.message.includes('SECRET'));
  });
});

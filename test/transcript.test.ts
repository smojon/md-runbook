import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_PATTERNS, createRedactor } from '@md-runbook/core';
import {
  TranscriptEntry,
  formatTranscriptDuration,
  lastHeading,
  transcriptExtensionProblem,
  transcriptFileName,
  transcriptFooter,
  transcriptHeader,
  transcriptNote,
} from '@md-runbook/core/transcript';
import { TranscriptFile } from '@md-runbook/core/node/transcript';

const AT = new Date(2026, 9, 28, 22, 14, 5);
const redactor = createRedactor(DEFAULT_PATTERNS);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** An entry writing into a string; `secrets` can grow while it runs, as knownSecrets does. */
function entry(hold = false, secrets: string[] = []): { e: TranscriptEntry; text: () => string } {
  let text = '';
  const redact = (t: string): string => secrets.reduce((s, v) => s.split(v).join('[REDACTED]'), redactor.redact(t));
  return { e: new TranscriptEntry((t) => (text += t), redact, hold), text: () => text };
}

describe('transcript: format', () => {
  it('writes a header, the command, output with a gutter per stream, and a footer', () => {
    const { e, text } = entry();
    e.start({ at: AT, runbook: 'deploy.runbook.md', step: 12, line: 40, section: '5. Push', title: 'Push it', command: 'git push\necho done\n' });
    e.out('stdout', 'Everything up-to-date\n');
    e.out('stderr', 'warning: x\n');
    e.end({ exit: '0', durationMs: 9100 });
    assert.match(text(), /^===== 2026-10-28T22:14:05[+-]\d\d:\d\d · deploy\.runbook\.md:40 · Step 12 · 5\. Push · Push it\n/);
    assert.ok(text().endsWith('$ git push\n$ echo done\n| Everything up-to-date\n! warning: x\n===== exit=0 · 9.1s\n\n'), text());
  });

  it('leaves out what is unknown, and keeps fields on one line', () => {
    assert.match(transcriptHeader({ at: AT, runbook: 'r.md', title: 'a\nb' }, (t) => t), /^===== \S+ · r\.md · a b\n$/);
  });

  it('marks checks, attempts and line runs in the footer', () => {
    assert.equal(transcriptFooter({ exit: '1', durationMs: 850, check: 'failed', attempt: 3, attempts: 5, lines: '2-4' }), '===== exit=1 · 850ms · check failed · attempt 3/5 · lines 2-4\n\n');
    assert.equal(transcriptFooter({ exit: '0', durationMs: 1000, attempt: 1, attempts: 1 }), '===== exit=0 · 1.0s\n\n');
    assert.equal(formatTranscriptDuration(125_000), '2m5s');
  });

  it('writes lines as the saved output does: no ANSI codes, a carriage return overwrites', () => {
    const { e, text } = entry();
    e.out('stdout', '\u001b[32mgreen\u001b[0m\r\n10%\r50%\r100%\n');
    e.end({ exit: '0', durationMs: 1 });
    assert.match(text(), /^\| green\n\| 100%\n/);
  });

  it('writes a line only once it is complete, and the last one at the end', () => {
    const { e, text } = entry();
    e.out('stdout', 'par');
    assert.equal(text(), '');
    e.out('stdout', 'tial\nno newline');
    assert.equal(text(), '| partial\n');
    e.end({ exit: '0', durationMs: 1 });
    assert.match(text(), /^\| partial\n\| no newline\n=====/);
  });

  it('marks a new attempt after what the last one printed', () => {
    const { e, text } = entry();
    e.out('stdout', 'first');
    e.attempt(2, 3, AT);
    e.out('stdout', 'second\n');
    e.end({ exit: '0', durationMs: 1 });
    assert.match(text(), /^\| first\n----- attempt 2\/3 · 2026-10-28T22:14:05\S+\n\| second\n/);
  });

  it('ignores output after the end, and a second end', () => {
    const { e, text } = entry();
    e.end({ exit: '0', durationMs: 1 });
    e.out('stdout', 'late\n');
    e.end({ exit: 'error', durationMs: 1 });
    assert.equal(text(), '===== exit=0 · 1ms\n\n');
  });

  it('writes a note on a line of its own', () => {
    assert.match(transcriptNote(AT, 'r.md', `checked: export ${TOKEN}`, (t) => redactor.redact(t)), /^===== \S+ · r\.md · checked: export \[REDACTED\]\n\n$/);
  });
});

describe('transcript: redaction', () => {
  it('redacts the command and a secret split across chunks', () => {
    const { e, text } = entry();
    e.start({ at: AT, runbook: 'r.md', command: `curl -H "Authorization: token ${TOKEN}"` });
    e.out('stdout', `token: ${TOKEN.slice(0, 10)}`);
    e.out('stdout', `${TOKEN.slice(10)}\n`);
    e.end({ exit: '0', durationMs: 1 });
    assert.doesNotMatch(text(), new RegExp(TOKEN.slice(4, 20)));
    assert.match(text(), /\| token: \[REDACTED\]/);
  });

  it('redacts a private key block as a whole', () => {
    const { e, text } = entry();
    e.out('stdout', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n');
    e.out('stdout', 'AAAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
    e.end({ exit: '0', durationMs: 1 });
    assert.doesNotMatch(text(), /b3BlbnNzaC1rZXkt|AAAAAAAAAA/);
  });

  it('holds output back until the end, when a secret learnt during the run is known', () => {
    const secrets: string[] = [];
    const { e, text } = entry(true, secrets);
    e.start({ at: AT, runbook: 'r.md' });
    e.out('stdout', 'value: tok-held-98765\n');
    assert.doesNotMatch(text(), /tok-held/);
    secrets.push('tok-held-98765');
    e.end({ exit: '0', durationMs: 1 });
    assert.match(text(), /\| value: \[REDACTED\]\n/);
    assert.doesNotMatch(text(), /tok-held/);
  });
});

describe('transcript: names', () => {
  it('replaces .md with the extension', () => {
    assert.equal(transcriptFileName('deploy.runbook.md'), 'deploy.runbook.transcript.log');
    assert.equal(transcriptFileName('notes.markdown', '.log'), 'notes.log');
  });

  it('refuses an extension that is a folder, has spaces or opens as a runbook', () => {
    assert.equal(transcriptExtensionProblem('.transcript.log'), undefined);
    assert.equal(transcriptExtensionProblem('.txt'), undefined);
    for (const bad of ['log', '.a/b', '.a\\b', '. log', '.run.md', '.MD', '']) assert.ok(transcriptExtensionProblem(bad), bad);
  });

  it('finds the last heading of a Markdown cell, not one inside a fence', () => {
    assert.equal(lastHeading('# 1. One\ntext\n## 2. Two ##\n'), '2. Two');
    assert.equal(lastHeading('## Real\n```bash\n# a comment\n```\n'), 'Real');
    assert.equal(lastHeading('~~~\n# x\n~~~\n'), undefined);
    assert.equal(lastHeading('plain text'), undefined);
  });
});

describe('transcript: file', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-transcript-'));

  it('batches appends, creates the folder and writes on flush', () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'r.transcript.log');
    const f = new TranscriptFile(file, undefined, 1024, 60_000);
    f.append('one\n');
    f.append('two\n');
    assert.equal(fs.existsSync(file), false, 'nothing written before the batch is due');
    f.flush();
    f.append('three\n');
    f.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a batch by itself after a moment', async () => {
    const dir = tmp();
    const file = path.join(dir, 'r.log');
    const f = new TranscriptFile(file, undefined, 1024, 10);
    f.append('soon\n');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.readFileSync(file, 'utf8'), 'soon\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts a new file past the size limit, keeping one older', () => {
    const dir = tmp();
    const file = path.join(dir, 'r.log');
    const f = new TranscriptFile(file, undefined, 10, 60_000);
    for (const t of ['aaaaaa\n', 'bbbbbb\n', 'cccccc\n']) {
      f.append(t);
      f.flush();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'cccccc\n');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'bbbbbb\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a failed write once and stops', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'blocker'), '');
    const errors: Error[] = [];
    const f = new TranscriptFile(path.join(dir, 'blocker', 'r.log'), (e) => errors.push(e), 1024, 60_000);
    f.append('x\n');
    f.flush();
    f.append('y\n');
    f.flush();
    assert.equal(errors.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

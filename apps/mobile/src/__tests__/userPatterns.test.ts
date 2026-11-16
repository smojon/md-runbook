/**
 * Security review round 4, finding 6: patterns you add (risky commands, redaction) compile with
 * RE2 first; a JavaScript fallback (look-around) only within a length cap and without nested
 * quantifiers, the shapes that backtrack catastrophically over the live output.
 */
import {
  MAX_JS_PATTERN,
  NO_LIVE_OUTPUT,
  compileUserPattern,
  confirmRegexes,
  liveWindow,
  outputRedactor,
  patternProblem,
} from '../settings/safety';
import { resetSettings, setConfirmPatterns, setRedactionPatterns } from '../settings/store';
import { STDERR_MARK, parse } from '@md-runbook/core';
import { confirmationFor } from '@md-runbook/core/confirm';
import { Host } from '../hosts/store';
import { runCell } from '../ssh/runCell';
import { fakeConnection } from '../testing/fakeConnection';

beforeEach(() => resetSettings());

describe('patterns of yours', () => {
  it('RE2 when it can read them; JavaScript only for look-around, within the limits', () => {
    expect(compileUserPattern('redaction', '(a+)+$')).toMatchObject({ kind: 're2' });
    expect(compileUserPattern('redaction', '(?<=key: )\\S+')).toMatchObject({ kind: 'js' });
    expect(compileUserPattern('redaction', '(?<=k)(\\w+\\s?)*$')).toEqual({
      why: expect.stringMatching(/quantifier inside a quantified group/),
    });
    expect(compileUserPattern('redaction', '(?<=k)' + 'a'.repeat(MAX_JS_PATTERN))).toEqual({
      why: expect.stringMatching(/longer than 200 characters/),
    });
    expect(patternProblem('redaction', '(?<=k)(x*){2,}', [])?.kind).toBe('invalid');
    expect(patternProblem('redaction', '(a+)+$', [])).toBeUndefined();
  });

  it('a pattern that backtracks in JavaScript runs in linear time under RE2', () => {
    setRedactionPatterns(['(a+)+$']);
    const text = 'a'.repeat(5000) + '!';
    const started = Date.now();
    expect(outputRedactor().redact(text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outputRedactor().redact('id aaa')).toBe('id [REDACTED]');
  });

  it('one saved before (no check then) that is refused now is left out, and said', () => {
    setRedactionPatterns(['(?<=k)(\\w+\\s?)*$', 'corp-\\d+']);
    expect(outputRedactor().redact('corp-12 kabc')).toBe('[REDACTED] kabc');
    expect(outputRedactor().errors).toEqual([expect.stringMatching(/quantifier inside a quantified group/)]);
  });

  it('risky-command patterns of yours ask first, RE2 or not; the built-in ones stay JavaScript', () => {
    setConfirmPatterns(['Terraform\\s+destroy', '(?<!echo )shutdown']);
    const regexes = confirmRegexes();
    expect(confirmationFor('cd infra && terraform   destroy -auto-approve', 'patterns', regexes)).toBe('terraform   destroy');
    expect(confirmationFor('shutdown -h now', 'patterns', regexes)).toBe('shutdown');
    expect(confirmationFor('echo shutdown', 'patterns', regexes)).toBeUndefined();
    // Non-ASCII text before the match: the match as written.
    expect(confirmationFor('# ünïcödé\nterraform destroy', 'patterns', regexes)).toBe('terraform destroy');
  });
});

describe('the live output', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij';

  /** The live output after these packets (each one shown in turn), with a window of `max`. */
  const feed = (packets: readonly string[], max = 20_000): string => packets.reduce((s, p) => liveWindow(s, p, max), NO_LIVE_OUTPUT).text;

  it('is redacted before it is cut to its window: no token’s end shows without its start', () => {
    const out = feed(['x'.repeat(30) + '\ntoken=' + JWT.slice(0, 30), JWT.slice(30) + '\nnext line\n'], 40);
    expect(out).not.toContain('abcdefghij');
    expect(out).not.toContain('IxIn0');
    expect(out).toMatch(/next line\n$/);
  });

  it('a token split across two packets: no tail shows after its start was redacted (round 5)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(feed(['token ' + jwt.slice(0, 30), jwt.slice(30) + '\n'])).toBe('token [REDACTED]\n');
    const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    expect(feed(['x ' + gh.slice(0, 36), gh.slice(36) + '\n'])).toBe('x [REDACTED]\n');
    expect(feed(['Authorization2 Bearer abcd1234', 'efgh5678ijkl\n'])).toBe('Authorization2 Bearer [REDACTED]\n');
    expect(feed(['curl -H "X: Bearer abcd1234', 'efgh5678ijkl"\n'])).toBe('curl -H "X: Bearer [REDACTED]"\n');
    expect(feed(['password=hunter', '2xyz\n'])).toBe('password=[REDACTED]\n');
    const pem = feed(['-----BEGIN RSA PRIVATE KEY-----\nMIIabc', 'defSECRETBODY\n-----END RSA PRIVATE KEY-----\n']);
    expect(pem).not.toMatch(/MIIabc|SECRETBODY/);
  });

  it('shows what redacting the whole output and cutting it would, however the packets fall', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij';
    const lines = Array.from({ length: 400 }, (_, i) =>
      i % 37 === 0 ? `token=${jwt}` : i % 53 === 0 ? `Authorization: Bearer abc${i}def456` : `line ${i} ${'.'.repeat(i % 90)}`,
    );
    const all = lines.join('\n') + '\n-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n';
    const whole = outputRedactor().redact(all);
    let seed = 7;
    for (const max of [500, 20_000]) {
      const packets: string[] = [];
      for (let at = 0; at < all.length; ) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const n = 1 + (seed % 300);
        packets.push(all.slice(at, at + n));
        at += n;
      }
      const out = feed(packets, max);
      expect(whole.endsWith(out)).toBe(true);
      expect(out.length).toBeGreaterThan(max - 200);
      expect(out).not.toMatch(/abcdefghij|MIIsecret|def456/);
    }
  });

  it('a known secret split across two packets never shows in part', async () => {
    const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };
    const conn = fakeConnection([{}]);
    // The server sends "sent s3cr3t-tok" then "en-value to api\n".
    conn.session.run = async (_source, opts = {}) => {
      opts.onStdout?.('sent s3cr3t-tok');
      opts.onStdout?.('en-value to api\n');
      return { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 };
    };
    const live: string[] = [];
    const r = await runCell({
      host,
      text: '```bash\ncurl -H "Authorization: Bearer ${secret:API_TOKEN}" https://api/\n```\n',
      cellIndex: 0,
      connection: conn,
      readSecret: async () => 's3cr3t-token-value',
      onOutput: (t) => live.push(t),
    });
    expect(r.kind).toBe('done');
    expect(live.join('')).toBe('sent [REDACTED] to api\n');
    expect(live.some((t) => t.includes('s3cr3t'))).toBe(false);
  });

  it('a known secret in a `set -x` trace on stderr, split across two packets: hidden live and in the file', async () => {
    const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };
    const conn = fakeConnection([{}]);
    const secret = 'S3cr3t-Value-0123456789';
    conn.session.run = async (_source, opts = {}) => {
      opts.onStderr?.('+ curl -H "X-Api: ' + secret.slice(0, 10));
      opts.onStderr?.(secret.slice(10) + '" https://api\n');
      return { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 };
    };
    const live: string[] = [];
    const r = await runCell({
      host,
      text: '```bash\nset -x; curl -H "X-Api: ${secret:API_KEY}" https://api\n```\n',
      cellIndex: 0,
      connection: conn,
      readSecret: async () => secret,
      onOutput: (t) => live.push(t),
    });
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    expect(live.join('')).toBe(`${STDERR_MARK}+ curl -H "X-Api: [REDACTED]" https://api\n`);
    expect(live.join('')).not.toMatch(/S3cr|0123456789/);
    const out = parse(r.text).cells[0]?.output;
    expect(out?.text).toBe('+ curl -H "X-Api: [REDACTED]" https://api');
    expect(out?.attrs.stderr).toBe('1');
  });
});

/**
 * Security review round 4, finding 6: patterns you add (risky commands, redaction) compile with
 * RE2 first; a JavaScript fallback (look-around) only within a length cap and without nested
 * quantifiers, the shapes that backtrack catastrophically over the live output.
 */
import { MAX_JS_PATTERN, compileUserPattern, confirmRegexes, liveWindow, outputRedactor, patternProblem } from '../settings/safety';
import { resetSettings, setConfirmPatterns, setRedactionPatterns } from '../settings/store';
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

  it('is redacted before it is cut to its window: no token’s end shows without its start', () => {
    const shown = 'x'.repeat(30) + '\ntoken=' + JWT.slice(0, 30);
    const out = liveWindow(shown, JWT.slice(30) + '\nnext line\n', 40);
    expect(out).not.toContain('abcdefghij');
    expect(out).not.toContain('IxIn0');
    expect(out).toMatch(/next line\n$/);
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
});

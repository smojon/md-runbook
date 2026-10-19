import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFrontMatter } from '@md-runbook/core/secrets';

describe('front matter: timeout and cwd', () => {
  it('reads timeout (seconds) and cwd next to params and mode', () => {
    assert.deepEqual(parseFrontMatter('---\nmode: session\ntimeout: 120\ncwd: ../infra  # comment\nparams:\n- HOST: x\n---\n'), {
      params: [{ name: 'HOST', default: 'x' }],
      mode: 'session',
      timeoutSeconds: 120,
      cwd: '../infra',
    });
    assert.deepEqual(parseFrontMatter('---\ntimeout: "30s"\ncwd: "../my infra"\n---\n'), { params: [], timeoutSeconds: 30, cwd: '../my infra' });
  });

  it('ignores invalid values', () => {
    assert.deepEqual(parseFrontMatter('---\ntimeout: soon\ncwd:\n---\n'), { params: [] });
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pastedBy, pastedReason } from '@md-runbook/core/pastedInfo';
import { proposedInfo } from '@md-runbook/core/proposal';

describe('pasted proposal info strings', () => {
  it('reason with nested quotes is kept whole', () => {
    assert.equal(pastedReason('bash proposed by=ai reason="use the "real" token"'), 'use the "real" token');
    assert.equal(proposedInfo('bash', 'ai', pastedReason('bash reason="use the "real" token"')), 'bash proposed by=ai reason="use the real token"');
  });

  it('ordinary tokens after the reason still end it', () => {
    assert.equal(pastedReason('bash reason="check pods" name="x y" skip'), 'check pods');
    assert.equal(pastedReason("bash reason='single' by=ai"), 'single');
    assert.equal(pastedReason('bash reason=plain by=ai'), 'plain');
    assert.equal(pastedReason('bash proposed'), undefined);
    assert.equal(pastedReason('bash reason="unclosed'), 'unclosed');
  });

  it('by= is kept as given (default ai)', () => {
    assert.equal(pastedBy('bash proposed by=claude'), 'claude');
    assert.equal(pastedBy('bash proposed'), 'ai');
    assert.equal(proposedInfo('bash', pastedBy('bash by="Claude Code"')), 'bash proposed by=Claude-Code');
  });
});

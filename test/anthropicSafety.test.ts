import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { baseUrlProblem, isValidApiKey, urlForDisplay } from '@md-runbook/core/anthropicStream';

describe('Anthropic key and base URL checks', () => {
  it('API keys must be printable ASCII without spaces', () => {
    assert.equal(isValidApiKey('sk-ant-api03-abc_DEF-123'), true);
    for (const k of ['', 'sk ant', 'sk-ant\n', 'sk-\x01x', 'sk-é']) assert.equal(isValidApiKey(k), false, JSON.stringify(k));
  });

  it('base URL: https, or http only for localhost; no credentials', () => {
    assert.equal(baseUrlProblem(''), undefined);
    assert.equal(baseUrlProblem('https://gw.example/anthropic'), undefined);
    assert.equal(baseUrlProblem('http://localhost:8080'), undefined);
    assert.equal(baseUrlProblem('http://127.0.0.1:8080/'), undefined);
    assert.match(baseUrlProblem('http://gw.example') ?? '', /https/);
    assert.match(baseUrlProblem('ftp://gw.example') ?? '', /https/);
    assert.match(baseUrlProblem('not a url') ?? '', /not a valid URL/);
    const creds = baseUrlProblem('https://user:s3cret@gw.example') ?? '';
    assert.match(creds, /credentials/);
    assert.doesNotMatch(creds, /s3cret/);
  });

  it('URLs in messages never show credentials', () => {
    assert.equal(urlForDisplay('https://user:s3cret@gw.example/x'), 'https://gw.example/x');
    assert.equal(urlForDisplay('https://api.anthropic.com'), 'https://api.anthropic.com');
    assert.doesNotMatch(urlForDisplay('bad://u:s3cret@ x'), /s3cret/);
  });
});

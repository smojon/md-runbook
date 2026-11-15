/** Run reports in VS Code (src/reportGate.ts): when a run starts, and when its summary goes signed. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SIGNING_KEY_MISSING, reportGate, summarySigning } from '../src/reportGate';

describe('VS Code run report gate', () => {
  const none = { required: false, signed: false };
  const required = { required: true, signed: false };
  const signed = { required: false, signed: true };
  const both = { required: true, signed: true };

  it('lets a runbook without report-runs, or with nothing honoured, run', () => {
    assert.deepEqual(reportGate(undefined, { keySet: false, agreed: false }), { kind: 'go' });
    assert.deepEqual(reportGate(none, { keySet: false, agreed: false }), { kind: 'go' });
  });

  it('refuses a runbook that requires signed reports without a key, whether or not it requires the report', () => {
    assert.deepEqual(reportGate(signed, { keySet: false, agreed: false }), { kind: 'refuse', why: 'key' });
    assert.deepEqual(reportGate(both, { keySet: false, agreed: true }), { kind: 'refuse', why: 'key' });
  });

  it('runs a runbook that requires signed reports when a key is set', () => {
    assert.deepEqual(reportGate(signed, { keySet: true, agreed: false }), { kind: 'go' });
  });

  it('asks before a required report, once agreed it runs', () => {
    assert.deepEqual(reportGate(required, { keySet: false, agreed: false }), { kind: 'ask' });
    assert.deepEqual(reportGate(both, { keySet: true, agreed: false }), { kind: 'ask' });
    assert.deepEqual(reportGate(required, { keySet: false, agreed: true }), { kind: 'go' });
  });

  it('never sends a summary unsigned when it must be signed', () => {
    assert.equal(summarySigning(signed, false), 'refuse');
    assert.equal(summarySigning(signed, true), 'sign');
    assert.equal(summarySigning(none, true), 'sign');
    assert.equal(summarySigning(none, false), 'unsigned');
  });

  it('says how to set a key up, as the command line does', () => {
    assert.match(SIGNING_KEY_MISSING, /runs only if its run summary is signed with your SSH key/);
    assert.match(SIGNING_KEY_MISSING, /mdRunbook\.signing\.key/);
    assert.match(SIGNING_KEY_MISSING, /namespace md-runbook-run/);
  });
});

/**
 * Which runbook a call's copy runs under (src/callTree.ts): the status bar and the Steps view show
 * a question a copy asks while its caller, or the caller's caller, is in front (a team's
 * report: a guide → a call → a call in it).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { runsUnder, setCaller } from '../src/callTree';

describe('runsUnder: a call copy and the runbooks that run it', () => {
  setCaller('copy:upgrade', 'file:campaign');
  setCaller('copy:release', 'copy:upgrade');
  setCaller('copy:other', 'file:other');

  it('a copy runs under its caller and its caller’s caller', () => {
    assert.equal(runsUnder('copy:upgrade', 'file:campaign'), true);
    assert.equal(runsUnder('copy:release', 'copy:upgrade'), true);
    assert.equal(runsUnder('copy:release', 'file:campaign'), true);
  });

  it('not under another runbook, itself or a copy it calls', () => {
    assert.equal(runsUnder('copy:release', 'file:other'), false);
    assert.equal(runsUnder('copy:other', 'file:campaign'), false);
    assert.equal(runsUnder('file:campaign', 'file:campaign'), false);
    assert.equal(runsUnder('copy:upgrade', 'copy:release'), false);
  });

  it('a loop in the record ends', () => {
    setCaller('copy:a', 'copy:b');
    setCaller('copy:b', 'copy:a');
    assert.equal(runsUnder('copy:a', 'file:none'), false);
  });
});

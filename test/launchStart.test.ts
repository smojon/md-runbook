import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LaunchModel } from '../src/launch';
import { missingParams, missingText, startValues } from '../src/launchStart';

const model = (params: LaunchModel['params'], inputs: LaunchModel['inputs'] = []): LaunchModel => ({
  title: 'r.md',
  uri: 'file:///r.md',
  params,
  inputs,
  secrets: [],
  risky: [],
  byHand: [],
  byHandWaits: true,
  needed: true,
});

describe('launch form Start', () => {
  it('a parameter with neither a value nor a default is missing, as in the app', () => {
    const params: LaunchModel['params'] = [
      { name: 'TAG' },
      { name: 'REGION', default: 'eu' },
      { name: 'EMPTY_OK', default: '' },
      { name: 'LAST', value: 'v1', from: 'last' },
      { name: 'ENV', choices: ['qa', 'prod'] },
    ];
    // Nothing sent: the values the form showed count.
    assert.deepEqual(missingParams(params, undefined), ['TAG', 'ENV']);
    // Cleared fields count as empty; a default (even empty) is enough.
    assert.deepEqual(missingParams(params, { params: { TAG: '1', REGION: '', EMPTY_OK: '', LAST: '', ENV: 'qa' } }), ['LAST']);
    assert.deepEqual(missingParams(params, { params: { TAG: '1', ENV: 'qa' } }), []);
  });

  it('Start refuses missing values, naming them all, and points at the first', () => {
    const m = model([{ name: 'TAG' }, { name: 'REGION', default: 'eu' }, { name: 'ZONE' }]);
    assert.deepEqual(startValues(m, { params: { TAG: '', REGION: 'eu', ZONE: '' } }), {
      error: 'Type a value for TAG, ZONE: they have no default.',
      field: 'param:TAG',
    });
    assert.equal(missingText(['TAG']), 'Type a value for TAG: it has no default.');
    assert.deepEqual(startValues(m, { params: { TAG: 'v2', ZONE: 'a' } }), { params: { TAG: 'v2', ZONE: 'a' }, inputs: {} });
  });

  it('a choice is checked first; an empty secret input is not a value', () => {
    const m = model([{ name: 'ENV', choices: ['qa', 'prod'] }], [{ name: 'PW', secret: true }, { name: 'WHO', secret: false }]);
    assert.deepEqual(startValues(m, { params: { ENV: 'dev' } }), { error: 'ENV must be one of: qa, prod', field: 'param:ENV' });
    assert.deepEqual(startValues(m, { params: { ENV: 'qa' }, inputs: { PW: '', WHO: 'ops' } }), { params: { ENV: 'qa' }, inputs: { WHO: 'ops' } });
  });
});

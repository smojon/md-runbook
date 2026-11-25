/** The words VS Code shows for the certificate on md-runbook's key (src/keyCertificate.ts). */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { caText, expiryWarning, inTime, keyIdText, localTime, principalsText, restrictionsText, validityText } from '../src/keyCertificate';

const now = Date.UTC(2026, 10, 25, 12, 0) / 1000;
const cert = (validAfter: number, validBefore: number, principals = ['alice']) => ({
  keyId: 'alice@corp',
  principals,
  validAfter,
  validBefore,
  serial: '9',
  caFingerprint: 'SHA256:x',
});

describe('VS Code: key certificate text', () => {
  it('says how long, rounded down', () => {
    assert.equal(inTime(3 * 86400 + 5), 'in 3 days');
    assert.equal(inTime(86400), 'in 24 hours');
    assert.equal(inTime(3 * 3600), 'in 3 hours');
    assert.equal(inTime(90 * 60), 'in 90 minutes');
    assert.equal(inTime(61), 'in 1 minute');
    assert.equal(inTime(5), 'in 1 minute');
  });

  it('says when it is valid', () => {
    const c = cert(now - 3600, now + 3 * 86400);
    assert.equal(validityText(c, 'valid', now * 1000), `Valid until ${localTime(now + 3 * 86400)} (in 3 days)`);
    assert.equal(validityText(cert(0, Infinity), 'valid', now * 1000), 'Valid forever');
    assert.equal(validityText(cert(0, now - 60), 'expired', now * 1000), `Expired ${localTime(now - 60)}`);
    assert.equal(validityText(cert(now + 7200, Infinity), 'not-yet', now * 1000), `Valid from ${localTime(now + 7200)} (in 2 hours)`);
    assert.match(localTime(now), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it('warns before and after expiry, not while valid', () => {
    assert.equal(expiryWarning(cert(0, now + 86400 * 5), 'valid', now * 1000), undefined);
    assert.match(expiryWarning(cert(0, now + 7200), 'expiring', now * 1000)!, /^The certificate "alice@corp" expires in 2 hours \(.+\)\. Get a new one from your CA\.$/);
    assert.match(expiryWarning(cert(0, now - 1), 'expired', now * 1000)!, /expired .+: hosts that need it refuse the login/);
    assert.match(expiryWarning({ ...cert(now + 60, Infinity), keyId: '' }, 'not-yet', now * 1000)!, /^The certificate of md-runbook’s key is valid from/);
  });

  it('lists the principals', () => {
    assert.equal(principalsText(cert(0, 1, ['alice', 'deploy'])), 'alice, deploy');
    assert.equal(principalsText(cert(0, 1, [])), 'no principals (any user)');
  });

  it("a certificate's text can't fake a line, reorder text or run long", () => {
    // A principal that would look like the CA line in the details' bullet list.
    assert.equal(principalsText(cert(0, 1, ['alice\n- CA: SHA256:fake'])), 'alice\\u{a}- CA: SHA256:fake');
    assert.equal(keyIdText({ keyId: 'ops‮gnp.exe' }), 'ops\\u{202e}gnp.exe');
    assert.equal(keyIdText({ keyId: '' }), 'no key ID');
    assert.equal(keyIdText({ keyId: 'k'.repeat(100) }), `${'k'.repeat(64)}…`);
    assert.equal(principalsText(cert(0, 1, Array.from({ length: 12 }, (_, i) => `u${i}`))), 'u0, u1, u2, u3, u4, u5, u6, u7, +4 more');
    assert.equal(restrictionsText({ criticalOptions: { 'force-command': '/bin/true', 'source-address': '10.0.0.0/8' } }), 'force-command, source-address');
    assert.equal(restrictionsText({ criticalOptions: {} }), undefined);
  });

  it('far or broken dates read as such, never NaN', () => {
    assert.equal(localTime(2 ** 60), 'far in the future');
    assert.equal(localTime(NaN), 'far in the future');
    assert.equal(inTime(Infinity), 'far in the future');
    assert.equal(validityText(cert(2 ** 60, Infinity), 'not-yet', now * 1000), 'Valid from far in the future (far in the future)');
  });

  it('says whether the CA signature was checked', () => {
    const c = { caFingerprint: 'SHA256:abc' };
    assert.equal(caText(c, 'valid'), 'CA SHA256:abc (signature checked)');
    assert.equal(caText(c, 'invalid'), 'CA SHA256:abc: signature not valid');
    assert.equal(caText(c, 'unchecked'), 'CA SHA256:abc (as the certificate says)');
  });
});

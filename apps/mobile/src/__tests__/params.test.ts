import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { checkParam, runbookParams } from '../runbooks/params';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';

describe('runbook parameters', () => {
  it('declared ones first (with defaults), then the ones the bash cells use', () => {
    const text =
      '---\nparams:\n  - NAMESPACE\n  - REGION: eu-west-1\n---\n\n' +
      fence('bash', 'echo ${param:TARGET} ${param:REGION}') +
      fence('pwsh', 'echo ${param:WIN_ONLY}');
    expect(runbookParams(text)).toEqual([{ name: 'NAMESPACE' }, { name: 'REGION', default: 'eu-west-1' }, { name: 'TARGET' }]);
    expect(runbookParams(fence('bash', 'echo hi'))).toEqual([]);
  });

  it('a signed runbook adds the pattern of each parameter', () => {
    const plain = fence('bash', 'systemctl restart ${param:SERVICE}');
    const built = buildManifest(plain, { name: 'ops/x', version: 1, scopes: [], patterns: { SERVICE: '[a-z-]+' } });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const signed = withSignature(plain, {
      signer: 'ops',
      signed: '2026-10-22',
      manifest: formatManifest(built.manifest),
      signature: 'U1NI',
    });
    expect(runbookParams(signed)).toEqual([{ name: 'SERVICE', pattern: '[a-z-]+' }]);
  });

  it('checks a value against the whole pattern, and refuses newlines', () => {
    const spec = { name: 'SERVICE', pattern: '[a-z-]+' };
    expect(checkParam(spec, 'api-gw')).toBeUndefined();
    expect(checkParam(spec, 'api; rm -rf /')).toBe('pattern');
    expect(checkParam(spec, 'Api')).toBe('pattern');
    expect(checkParam(spec, 'a\nb')).toBe('newline');
    expect(checkParam({ name: 'FREE' }, 'anything at all')).toBeUndefined();
    // POSIX classes as grep -E reads them; ones the app can't translate are left to the gate.
    expect(checkParam({ name: 'X', pattern: '[[:alpha:]][[:alnum:]_-]*' }, 'web_1')).toBeUndefined();
    expect(checkParam({ name: 'X', pattern: '[[:alpha:]]+' }, '1')).toBe('pattern');
    expect(checkParam({ name: 'X', pattern: '[[:punct:]]' }, 'x')).toBeUndefined();
    expect(checkParam({ name: 'X', pattern: '(' }, 'x')).toBeUndefined();
  });
});

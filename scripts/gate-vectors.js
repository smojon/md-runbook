// The shared test vectors of md-runbook-gate and its clients: apps/gate/testdata/vectors.json.
//
// Each vector is an input (a manifest, a fence info string, a name, a runbook or a request line,
// exactly as bytes: the file escapes every control and non-ASCII character) and core's reading of
// it. The gate's Go test (apps/gate/internal/vectors) reads every vector its own way and must reach
// the same reading; test/gateVectors.test.ts regenerates the file in memory and must find it
// unchanged, so a change to how core reads any of these fails until the file is written again on
// purpose:
//
//   npm run gate-vectors        (builds core and ssh, then writes the file)
//   node scripts/gate-vectors.js --check
//
// The gate never reads Markdown: for a runbook, what it reads is the manifest core builds from it.
// The rest of a runbook vector (front matter, cells, the signed text) pins core's own reading.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'apps', 'gate', 'testdata', 'vectors.json');

function load() {
  return {
    signing: require('@md-runbook/core/signing'),
    cellOptions: require('@md-runbook/core/cellOptions'),
    secrets: require('@md-runbook/core/secrets'),
    parser: require('@md-runbook/core/parser'),
    lint: require('@md-runbook/core/lint'),
    sha: require('@md-runbook/core/sha256'),
    pattern: require('@md-runbook/core/signedPattern'),
    ssh: require('@md-runbook/ssh'),
  };
}

const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');
/** A long string as its length and hash (both sides do the same), so the file stays small. */
const LONG = 512;
const str = (c, s) => (utf8Bytes(s) <= LONG ? s : { bytes: utf8Bytes(s), sha256: c.sha.sha256Hex(s) });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---- manifests ----

/** Core's reading of a manifest: refused, or what the gate's reads must find. */
function manifestReading(c, text) {
  let m;
  try {
    m = c.signing.parseManifest(text);
  } catch (e) {
    return { ok: false, why: e.message };
  }
  return {
    ok: true,
    name: m.name,
    version: String(m.version),
    expires: m.expires ?? '',
    scopes: m.scopes,
    text: m.text ?? '',
    params: Object.entries(m.patterns).map(([k, v]) => [k, str(c, v)]),
    cells: m.cells.map((cell) => {
      const kube = c.cellOptions.gateKubeContext(cell.info);
      return {
        n: String(cell.n),
        lines: cell.lines,
        info: str(c, cell.info),
        code: str(c, cell.code),
        needs: cell.needs,
        cwd: cell.cwd ?? '',
        env: Object.entries(cell.env).map(([k, v]) => [k, str(c, v)]),
        steps: cell.steps.map((s) => str(c, s)),
        kube: kube.want ?? '',
      };
    }),
    calls: m.calls.map((call) => ({ n: String(call.n), info: str(c, call.info), body: str(c, call.body), needs: call.needs })),
  };
}

const T64 = 'ab0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
/** A manifest as formatManifest writes it: every kind of item once. */
const BASE_LINES = [
  'md-runbook-manifest 1',
  'name ops/test',
  'version 3',
  'expires 2030-01-01',
  'scope web staging',
  `text ${T64}`,
  `param TARGET ${b64('[a-z]+(-[0-9]{1,3})?')}`,
  `param CTX ${b64('lab-[0-9]+|prod-eu')}`,
  'cell 1 all',
  `info ${b64('bash')}`,
  `code ${b64('echo one')}`,
  'cell 2 any',
  `info ${b64('bash kube-context=${param:CTX} cwd=/tmp env.GREETING=hello')}`,
  `code ${b64('echo a\necho ${TARGET}')}`,
  'needs TARGET',
  `cwd ${b64('/tmp')}`,
  `env GREETING ${b64('hello')}`,
  `env OTHER ${b64('')}`,
  `step ${b64('echo a')}`,
  `step ${b64('echo ${TARGET}')}`,
  'call 1',
  `callinfo ${b64('runbook src=other.md')}`,
  `callbody ${b64('TARGET=${param:TARGET}')}`,
  'callneeds TARGET',
  'end',
];
const joinLines = (lines) => lines.join('\n') + '\n';
const replaceLine = (lines, i, l) => lines.map((x, k) => (k === i ? l : x));
const withLine = (key, line) => {
  const i = BASE_LINES.findIndex((l) => l === key || l.startsWith(key + ' '));
  return joinLines(replaceLine(BASE_LINES, i, line));
};
const cellLine = (n, key) => {
  // The index of `key` in cell n.
  let cell = 0;
  for (let i = 0; i < BASE_LINES.length; i++) {
    if (BASE_LINES[i].startsWith('cell ')) cell++;
    if (cell === n && (BASE_LINES[i] === key || BASE_LINES[i].startsWith(key + ' '))) return i;
  }
  throw new Error(`no ${key} in cell ${n}`);
};
const withCellLine = (n, key, line) => joinLines(replaceLine(BASE_LINES, cellLine(n, key), line));
/** Base64 of bytes (not text): invalid UTF-8 and the like. */
const b64Bytes = (bytes) => Buffer.from(bytes).toString('base64');

function manifestInputs() {
  const out = [];
  const add = (id, input) => out.push({ id, input });
  add('base', joinLines(BASE_LINES));
  add('base-v1 (no text item)', joinLines(BASE_LINES.filter((l) => !l.startsWith('text '))));
  add('minimal', 'md-runbook-manifest 1\nname x\nversion 1\nend\n');
  add('empty', '');
  add('header only', 'md-runbook-manifest 1');
  add('header and newline', 'md-runbook-manifest 1\n');
  add('header 2', 'md-runbook-manifest 2\nname x\nversion 1\nend\n');
  add('header with CR', 'md-runbook-manifest 1\r\nname x\nversion 1\nend\n');
  add('BOM before header', '\ufeffmd-runbook-manifest 1\nname x\nversion 1\nend\n');
  add('no end', joinLines(BASE_LINES.slice(0, -1)));
  add('end without newline', joinLines(BASE_LINES).slice(0, -1));
  add('blank line after end', joinLines(BASE_LINES) + '\n');
  add('item after end', joinLines(BASE_LINES) + 'cell 3 all\n');
  add('CRLF everywhere', joinLines(BASE_LINES).replace(/\n/g, '\r\n'));
  add('lone CR everywhere', joinLines(BASE_LINES).replace(/\n/g, '\r'));
  add('mixed line endings', BASE_LINES.map((l, i) => l + ['\n', '\r\n', '\n'][i % 3]).join(''));
  add('NUL at the end', joinLines(BASE_LINES) + '\0');
  // Systematically, each line of the base: left out, twice, moved to the end (before `end`), with
  // a CR, a tab for its space, two spaces, a space before or after, or a word added.
  BASE_LINES.forEach((line, i) => {
    if (i === 0) return;
    const key = line.split(' ')[0];
    const at = `line ${i + 1} (${key})`;
    add(`${at}: left out`, joinLines(BASE_LINES.filter((_, k) => k !== i)));
    add(`${at}: twice`, joinLines([...BASE_LINES.slice(0, i + 1), line, ...BASE_LINES.slice(i + 1)]));
    if (i < BASE_LINES.length - 1) {
      add(`${at}: moved before end`, joinLines([...BASE_LINES.filter((_, k) => k !== i && k !== BASE_LINES.length - 1), line, 'end']));
      add(`${at}: swapped with the next`, joinLines(BASE_LINES.map((l, k) => (k === i ? BASE_LINES[i + 1] : k === i + 1 ? line : l))));
    }
    add(`${at}: CR at its end`, joinLines(replaceLine(BASE_LINES, i, line + '\r')));
    add(`${at}: a space before`, joinLines(replaceLine(BASE_LINES, i, ' ' + line)));
    add(`${at}: a space after`, joinLines(replaceLine(BASE_LINES, i, line + ' ')));
    add(`${at}: a word more`, joinLines(replaceLine(BASE_LINES, i, line + ' x')));
    if (line.includes(' ')) {
      add(`${at}: a tab for its space`, joinLines(replaceLine(BASE_LINES, i, line.replace(' ', '\t'))));
      add(`${at}: two spaces`, joinLines(replaceLine(BASE_LINES, i, line.replace(' ', '  '))));
      add(`${at}: upper-case key`, joinLines(replaceLine(BASE_LINES, i, key.toUpperCase() + line.slice(key.length))));
    }
  });
  // Version numbers.
  for (const v of ['1', '9', '10', '999999', '1000000', '0', '00', '01', '007', '-1', '+1', '1.0', '1.', '.5', '1e3', '0x10', '1_000', ' 1', '1 ', '\uff11', '\u0661', '\u00b9', 'one', 'NaN', 'Infinity', '']) {
    add(`version ${JSON.stringify(v)}`, withLine('version', `version ${v}`));
  }
  // Dates.
  for (const d of ['2030-01-01', '2028-02-29', '2027-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-19-39', '2026-1-1', '2026/01/01', '20260101', '2026-01-01T00:00:00Z', '0000-01-01', '9999-12-31', '\uff12026-01-01', ' 2030-01-01', '']) {
    add(`expires ${JSON.stringify(d)}`, withLine('expires', `expires ${d}`));
  }
  // Names and scopes.
  for (const n of ['ops/test', 'a', 'A.b_c-d/e', '-ops', '.ops', '/ops', 'ops test', 'ops\ttest', 'x'.repeat(100), 'x'.repeat(101), 'ops\u00e9', '']) {
    add(`name ${JSON.stringify(n)}`, withLine('name', `name ${n}`));
  }
  for (const s of ['web', 'web staging', 'web web', 'web  staging', 'web\tstaging', '*', '-web', 'web/x', 'x'.repeat(64), 'x'.repeat(65), '']) {
    add(`scope ${JSON.stringify(s)}`, withLine('scope', `scope ${s}`));
  }
  for (const t of [T64.toUpperCase(), T64.slice(1), T64 + 'a', 'sha256:' + T64]) add(`text ${JSON.stringify(t)}`, withLine('text', `text ${t}`));
  // Parameter and env names (the full set of names is in the name vectors).
  for (const n of ['TARGET2', 'PATH', 'path', 'LD_PRELOAD', 'Https_Proxy', 'FOO_proxy', '1X', 'X-Y', '__mdrb_x', 'MD_RUNBOOK_GATE_X', 'KUBECONFIG', '\u212aey']) {
    add(`param ${JSON.stringify(n)}`, withLine('param TARGET', `param ${n} ${b64('[a-z]+')}`));
    add(`env ${JSON.stringify(n)}`, withCellLine(2, 'env', `env ${n} ${b64('x')}`));
  }
  for (const pat of ['a)|(b', '[a-z\\-]+', '\\t', '[:alpha:]', 'a**', '[a-z]+', '(a|b)+']) add(`pattern ${JSON.stringify(pat)}`, withLine('param TARGET', `param TARGET ${b64(pat)}`));
  for (const n of ['__proto__', 'constructor', 'prototype']) {
    add(`param ${n}`, withLine('param CTX', `param ${n} ${b64('[a-z]+')}`));
    add(`env ${n}`, withCellLine(2, 'env', `env ${n} ${b64('x')}`));
  }
  // Values: base64 forms.
  const values = {
    'canonical': b64('echo hi'),
    'non-canonical padding bits': 'QR==',
    'no padding': 'QQ',
    'padding inside': 'QQ==QQ==',
    'URL-safe alphabet': b64('??>').replace(/\+/g, '-').replace(/\//g, '_'),
    'a BOM first': b64('\ufeffecho hi'),
    'a BOM inside': b64('echo \ufeffhi'),
    'invalid UTF-8': b64Bytes([0x65, 0xff, 0x0a]),
    'a UTF-8 surrogate': b64Bytes([0xed, 0xa0, 0x80]),
    'an overlong slash': b64Bytes([0xc0, 0xaf]),
    'a NUL': b64('echo\0hi'),
    'a CR': b64('echo hi\r'),
    'a lone CR line end': b64('echo a\recho b'),
    'CRLF': b64('echo a\r\necho b'),
    'a newline at its end': b64('echo hi\n'),
    'non-ASCII': b64('echo h\u00e9 \u{1F600}'),
    'empty': '',
    'whitespace': ' ',
  };
  for (const [what, v] of Object.entries(values)) {
    add(`code: ${what}`, withCellLine(1, 'code', `code ${v}`));
    add(`step: ${what}`, withCellLine(2, 'step', `step ${v}`));
    add(`cwd: ${what}`, withCellLine(2, 'cwd', `cwd ${v}`));
    add(`env value: ${what}`, withCellLine(2, 'env', `env GREETING ${v}`));
    add(`info: ${what}`, withCellLine(1, 'info', `info ${v}`));
    add(`pattern: ${what}`, withLine('param TARGET', `param TARGET ${v}`));
    add(`callbody: ${what}`, joinLines(replaceLine(BASE_LINES, BASE_LINES.findIndex((l) => l.startsWith('callbody ')), `callbody ${v}`)));
  }
  // Cells and calls: numbers and modes.
  for (const l of ['cell 1 all', 'cell 1 any', 'cell 1', 'cell 1 ALL', 'cell 1 some', 'cell 0 all', 'cell 01 all', 'cell 2 all', 'cell +1 all', 'cell 1.0 all', 'cell x all']) {
    add(`first cell line ${JSON.stringify(l)}`, joinLines(replaceLine(BASE_LINES, BASE_LINES.indexOf('cell 1 all'), l)));
  }
  add('second cell numbered 1', joinLines(replaceLine(BASE_LINES, BASE_LINES.indexOf('cell 2 any'), 'cell 1 any')));
  add('second cell numbered 3', joinLines(replaceLine(BASE_LINES, BASE_LINES.indexOf('cell 2 any'), 'cell 3 any')));
  for (const l of ['call 1', 'call 0', 'call 2', 'call 01', 'call']) add(`call line ${JSON.stringify(l)}`, joinLines(replaceLine(BASE_LINES, BASE_LINES.indexOf('call 1'), l)));
  add('needs an undeclared parameter', withCellLine(2, 'needs', 'needs OTHER'));
  add('needs a parameter twice', joinLines([...BASE_LINES.slice(0, cellLine(2, 'needs') + 1), 'needs TARGET', ...BASE_LINES.slice(cellLine(2, 'needs') + 1)]));
  add('needs CTX too', joinLines([...BASE_LINES.slice(0, cellLine(2, 'needs') + 1), 'needs CTX', ...BASE_LINES.slice(cellLine(2, 'needs') + 1)]));
  add('callneeds undeclared', joinLines(replaceLine(BASE_LINES, BASE_LINES.indexOf('callneeds TARGET'), 'callneeds OTHER')));
  add('env set twice in a cell', joinLines(replaceLine(BASE_LINES, cellLine(2, 'env') + 1, `env GREETING ${b64('again')}`)));
  add('no cells or calls', 'md-runbook-manifest 1\nname x\nversion 1\nend\n');
  add('a cell without code', joinLines(BASE_LINES.filter((_, k) => k !== cellLine(1, 'code'))));
  add('a cell without info', joinLines(BASE_LINES.filter((_, k) => k !== cellLine(1, 'info'))));
  add('a call without its body', joinLines(BASE_LINES.filter((l) => !l.startsWith('callbody '))));
  // A cell's kube-context= (the info vectors have the full set).
  for (const info of ['bash kube-context=prod-eu', 'bash kube-context=${param:CTX}', 'bash kube-context=${param:TARGET}', 'bash kube-context=${param:NOPE}', 'bash kube-context="two words"', 'bash kube-context=a kube-context=b', 'bash KUBE-CONTEXT=prod', 'bash \u212aube-context=prod', 'bash\u00a0 kube-context=prod', '\u00a0 kube-context=prod']) {
    add(`info ${JSON.stringify(info)}`, withCellLine(1, 'info', `info ${b64(info)}`));
  }
  // Long lines: a cell of 1 MB and an info string of 100 kB.
  add('a 1 MB cell', withCellLine(1, 'code', `code ${b64('echo ' + 'x'.repeat(1_000_000))}`));
  add('a 100 kB info string', withCellLine(1, 'info', `info ${b64('bash name="' + 'x'.repeat(100_000) + '"')}`));
  return out;
}

// ---- fence info strings: kube-context= ----

function infoInputs() {
  const out = new Set();
  const prefixes = ['bash', 'bash ', 'sh', '', ' ', '\t', ' bash', '\tbash', '\u00a0', '\u00a0 ', '\u00a0bash', '\u2028', '\u2028 ', '\ufeff', '\u3000 ', '\f', '\v ', 'bash{.x}', '{bash}', 'bash{', 'bash\u00a0'];
  const keys = ['kube-context', 'KUBE-CONTEXT', 'Kube-Context', '\u212aube-context', '\u212aUBE-CONTEXT', 'kube-contexT', 'kube_context', 'kubecontext', 'kube-context\u200b', '\u200bkube-context', 'k\u00fcbe-context', 'kube-\u0441ontext', 'kube\u2010context', 'kube-context.x', 'env.kube-context'];
  const values = ['prod', 'prod-eu', 'a@b/c:d+e_f.g-h', '"prod"', "'prod'", '" prod "', "' prod'", '"pr od"', '"prod', "'prod", '""', '', '${param:CTX}', '"${param:CTX}"', '${param:1X}', '${param:}', '${param:CTX', '${input:CTX}', '-prod', '.prod', 'prod!', '"pr\u00a0od"', '"\u00a0prod"', '"prod\u00a0"', '"\u2028prod"', '"\tprod\t"', '"prod\f"', '\u00a0prod', 'pr\u00e9d', 'a'.repeat(253), 'a'.repeat(254), '"a b"x', 'prod"', "prod'x'"];
  for (const p of prefixes) for (const k of keys.slice(0, 6)) out.add(`${p} ${k}=prod`.replace(/^ /, p === '' ? '' : ' '));
  for (const p of prefixes) out.add(`${p}kube-context=prod`);
  for (const k of keys) for (const v of values.slice(0, 8)) out.add(`bash ${k}=${v}`);
  for (const v of values) out.add(`bash kube-context=${v}`);
  for (const v of values) out.add(`bash timeout=5 kube-context=${v} env.X=1`);
  const seps = [' ', '\t', '  ', ' \t', '\u00a0', '\u2028', '\f'];
  for (const s of seps) {
    out.add(`bash${s}kube-context=prod`);
    out.add(`bash x=1${s}kube-context=prod`);
    out.add(`bash kube-context=prod${s}kube-context=lab`);
    out.add(`bash kube-context=pr${s}od`);
  }
  // Twice, with values valid or not; braces and flags around.
  for (const [a, b] of [['prod', 'prod'], ['prod', 'lab'], ['prod', '"two words"'], ['"two words"', 'prod'], ['prod', ''], ['', 'prod'], ['prod', '${param:CTX}']]) {
    out.add(`bash kube-context=${a} kube-context=${b}`);
    out.add(`bash kube-context=${a} KUBE-CONTEXT=${b}`);
  }
  for (const i of [
    'bash {kube-context=x} kube-context=y',
    'bash {kube-context=x kube-context=y',
    'bash {.a} kube-context=y {.b}',
    'bash kube-context=y {',
    'bash kube-context',
    'bash kube-context kube-context=prod',
    'bash kube-context= prod',
    'bash kube-context =prod',
    'bash kube-context==prod',
    'bash kube-context="prod" kube-context',
    'bash name="kube-context=x"',
    "bash name='a kube-context=x'",
    'bash name="a kube-context=x',
    'bash =prod kube-context=lab',
    'bash ="x kube-context=lab"',
    'kube-context=prod',
    '',
    '{kube-context=prod}',
    'bash\u00a0kube-context=prod kube-context=lab',
  ]) out.add(i);
  return [...out];
}

function infoReading(c, info) {
  const k = c.cellOptions.gateKubeContext(info);
  return k.problem ? { has: true, ok: false } : k.want !== undefined ? { has: true, ok: true, want: k.want } : { has: false, ok: true };
}

// ---- names a parameter or env.* value may have ----

function nameInputs(c) {
  const out = new Set();
  const swap = (s) => [...s].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');
  const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  for (const n of c.signing.RESERVED_VARS) for (const v of [n, n.toLowerCase(), n.toUpperCase(), swap(n), title(n), n + '_X', 'X' + n, n + '1']) out.add(v);
  for (const p of c.signing.RESERVED_VAR_PREFIXES) for (const v of [p, p + 'X', p.toLowerCase() + 'x', p.toUpperCase() + 'X', 'X' + p, p.slice(0, -1)]) out.add(v);
  for (const n of [
    'TARGET', 'target', '_', '_X', 'X1', '1X', '', 'X-Y', 'X.Y', 'X Y', 'KUBECONFIG', 'SHLVL', 'USER', 'TZ', 'TERM',
    'proxy', '_proxy', 'PROXY', 'X_PROXYX', 'Http_Proxy', 'hTTPS_pROXY', 'FOO_proxy', 'foo_PROXY', 'socks_proxy', 'SOCKS5_PROXY', 'NO_proxy', 'x_Proxy',
    // Unicode look-alikes and invisible characters: never a shell variable name.
    '\uff30\uff21\uff34\uff28', 'P\u0410TH', '\u0420ATH', 'PATH\u200b', '\u200bPATH', 'PAT\u0397', 'LD\uff3fPRELOAD', '\u212aUBECONFIG', 'pat\u0131', 'PAT\u0130',
    'HOME\0', 'PATH\n', 'PATH\r', 'PATH ', ' PATH', '\ufeffPATH',
    // Names a JavaScript object reads otherwise (review of 0.28.0).
    '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '__PROTO__', 'Constructor', '__proto', 'proto__',
  ]) out.add(n);
  return [...out];
}

// ---- parameter patterns ----

/** Patterns: the review's, then every atom with every repetition, around groups and anchors. */
function patternInputs() {
  const out = new Set([
    // Review of 0.28.0: an unbalanced group left the anchors (M1), backslashes (M2), [:alpha:] alone.
    'a)|(b', 'a)|(.*', '.*)|(a', ')(', '(a', 'a)', '((a)', '(a))', 'a)(b', '(a)|(b)', '(a|b)', 'a|b', '\\(a', 'a\\)', '\\)|\\(',
    '[A-Za-z0-9_\\-]+', '[a\\]]', '[\\]', '[\\.]', '[\\\\]', '\\t', '\\x41', '\\d', '\\w', '\\s', '\\b', '\\1', '\\<', '\\-', '\\/', '\\a', '\\', 'a\\',
    '\\.', '\\[', '\\]', '\\(', '\\)', '\\*', '\\+', '\\?', '\\{', '\\}', '\\|', '\\^', '\\$', '\\\\',
    '[:alpha:]', '[:alpha:]+', '[^:alpha:]', '[[:alpha:]]', '[[:alpha:][:digit:]]', '[[:word:]]', '[[:ALPHA:]]', '[:a]', '[a:]', '[::]',
    '[[:alnum:]]', '[[:blank:]]', '[[:cntrl:]]', '[[:graph:]]', '[[:lower:]]', '[[:print:]]', '[[:punct:]]', '[[:space:]]', '[[:upper:]]', '[[:xdigit:]]',
    '[[=a=]]', '[[.a.]]', '[[.-.]]', '[[=ab=]]', '[[.\\.]]', '[a-[:digit:]]', '[[:digit:]-z]', '[z-a]', '[a-a]', '[]a]', '[^]a]', '[a-]', '[-a]', '[[]', '[a', '[]', '[^]',
    '[\u00e9]', '\u00e9', '\u00e9+', '.', '..', '.{2}', '\u00e9{2}',
    '(?i)a', '(?:a)', 'a{,3}', 'a{x}', 'a{1', 'a{1,2,3}', '{1}', 'a}', 'a]', '}', ']', '{', 'a{', '^*', '*a', 'a|*b', '(*a)', '(|a)', 'a|', '|', '()', '()*', '(a*)*', '(a+)+',
    'a**', 'a*+', 'a+?', 'a??', 'a{2}?', 'a{2}*', 'a{2}{3}', 'a{0}', 'a{255}', 'a{256}', 'a{2,1}', 'a{01}', 'a{1,01}', 'a{1000}', 'a{0,}',
    '^a$', 'a^', '$a', '^$', 'a\tb', 'a\u007fb', ' ', 'a b',
    '[a-z][a-z0-9-]{0,30}', 'lab-[0-9]+|prod-eu', '[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,252}', '^(api|web)$', '.+', '.*', '[a-z]+', '[a-z]+(-[0-9]{1,3})?',
  ]);
  const atoms = ['a', '.', '[a-c]', '[^a]', '[[:digit:]]', '\\.', '\\\\', '(a|b)', '()', '\u00e9', '\\t', '[\\]'];
  const reps = ['', '*', '+', '?', '{2}', '{1,}', '{0,2}', '**', '+?', '{256}', '{2,1}', '{01}'];
  for (const a of atoms) for (const r of reps) out.add(a + r);
  for (const [pre, post] of [['^', ''], ['', '$'], ['x|', ''], ['', '|x'], ['(', ')'], ['(', ''], ['', ')'], (['b', 'c'])]) for (const a of atoms) out.add(pre + a + post);
  return [...out];
}

const PATTERN_VALUES = ['', 'a', 'b', 'c', 'ab', 'aa', 'aaa', 'abab', 'x', '1', '12', '.', '\\', ']', '[', '-', ':', '\u00e9', '\u00e9\u00e9', 't', '\t', 'A', ' ', 'a;b', 'a; echo INJECTED', 'zzb', 'bc', 'xa', '$x', 'a\rb', 'a\nb', 'a\0b', '()', 'web-1', 'prod-eu', 'lab-12'];

function patternReading(c, pattern) {
  const problem = c.pattern.signedPatternProblem(pattern);
  if (problem !== undefined) return { ok: false };
  return { ok: true, match: PATTERN_VALUES.filter((v) => c.pattern.matchesSignedPattern(pattern, v)) };
}

function nameReading(c, n) {
  const isVar = c.secrets.VAR_NAME_RE.test(n);
  return { var: isVar, reserved: c.signing.isReservedVar(n), settable: isVar && !c.signing.isReservedVar(n) };
}

// ---- runbooks ----

const SIG = 'U1NIU0lHAAAAAQ' + 'A'.repeat(150);
const META = { name: 'ops/test', version: 3, scopes: ['web'], patterns: { TARGET: '[a-z]+', CTX: 'lab-[0-9]+|prod-eu' } };

function runbookTemplates(c) {
  const t = [];
  const add = (id, text, meta = META) => t.push({ id, text, meta });
  add('plain', '# Restart\n\n```bash\necho hi\n```\n');
  add('empty', '');
  add('only prose', '# Nothing to run\n\nJust text.\n');
  add('front matter and options', '---\nparams:\n  - TARGET: web\nmode: session\n---\n\n# T\n\n```bash kube-context=prod-eu env.REGION=eu cwd=/tmp\necho ${param:TARGET}\nls\n```\n\n```sh lines=any\necho two\n```\n');
  add('front matter never closed', '---\nparams:\n  - TARGET\n\n```bash\necho ${param:TARGET}\n```\n');
  add('front matter after a blank line', '\n---\nmode: session\n---\n\n```bash\necho hi\n```\n');
  add('front matter closed by ...', '---\nmode: isolated\n...\n\n```bash\necho hi\n```\n');
  add('front matter shell: zsh', '---\nshell: zsh\n---\n\n```bash\necho hi\n```\n');
  add('front matter kube-context:, a block without its own', '---\nkube-context: prod-eu\n---\n\n```bash\necho hi\n```\n');
  add('front matter kube-context:, every block with its own', '---\nkube-context: prod-eu\n---\n\n```bash kube-context=prod-eu\necho hi\n```\n');
  add('front matter env:', '---\nenv:\n  REGION: eu\n  REGION: us\n  PATH: /evil\n---\n\n```bash\necho $REGION\n```\n');
  // The run report keys, each written twice in every order of values.
  const REPORT = '---\nreport-runs: https://reports.example.net/runs\n';
  for (const [a, b] of [['true', 'false'], ['false', 'true'], ['true', 'separated'], ['separated', 'true'], ['separated', 'false'], ['yes', 'no'], ['bogus', 'true'], ['true', 'bogus'], ['true', 'true']]) {
    add(`report-runs-required: ${a}, then ${b}`, `${REPORT}report-runs-required: ${a}\nreport-runs-required: ${b}\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  }
  for (const [a, b] of [['true', 'false'], ['false', 'true']]) {
    add(`report-runs-signed: ${a}, then ${b}`, `${REPORT}report-runs-signed: ${a}\nreport-runs-signed: ${b}\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  }
  add('report-runs twice, the first not an address', '---\nreport-runs: http://reports.example.net/runs\nreport-runs: https://reports.example.net/runs\n---\n\n```bash\necho hi\n```\n');
  add('report-runs twice', '---\nreport-runs: https://a.example.net/runs\nreport-runs: https://b.example.net/runs\n---\n\n```bash\necho hi\n```\n');
  add('report-runs-token twice', `${REPORT}report-runs-token: \${secret:A}\nreport-runs-token: \${secret:B}\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('report-runs-token, a literal then a secret', `${REPORT}report-runs-token: abc123\nreport-runs-token: \${secret:B}\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('report-runs-required, any case', `${REPORT}Report-Runs-Required: TRUE\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  // Notes and run records: in prose, next to a fence, inside one.
  const NOTE = '<!-- md-runbook:note at=2026-11-16T10:00:00Z by=ops -->\n> Restarted the web tier.\n';
  const RECORD = `<!-- md-runbook:record-signature v1 signer=ops signed=2026-11-16T10:00:00Z sha256=${'0'.repeat(64)}\nsignature\nAAAA\n-->\n`;
  add('a note in prose', `# T\n\n${NOTE}\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('a note right after a fence', `# T\n\n\`\`\`bash\necho hi\n\`\`\`\n${NOTE}`);
  add('a note right before a fence', `# T\n\n${NOTE}\`\`\`bash\necho hi\n\`\`\`\n`);
  add('a note inside a fence', `# T\n\n\`\`\`bash\necho hi\n${NOTE}\`\`\`\n`);
  add('a note inside a tilde fence', `# T\n\n~~~bash\necho hi\n${NOTE}~~~\n`);
  add('a note above the front matter', `${NOTE}---\nmode: session\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('a note inside the front matter', `---\nenv:\n${NOTE}  REGION: eu\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('a note with HTML after its comment', '# T\n\n<!-- md-runbook:note by=ops --> <b>shown</b>\n> x\n\n```bash\necho hi\n```\n');
  add('a run record in prose', `# T\n\n\`\`\`bash\necho hi\n\`\`\`\n\n${RECORD}`);
  add('a run record inside a fence', `# T\n\n\`\`\`bash\necho hi\n${RECORD}\`\`\`\n`);
  add('a run record ended early', `# T\n\n<!-- md-runbook:record-signature v1 signer=ops signed=x sha256=${'0'.repeat(64)}\nsignature\nAAAA\nx -->\n**shown**\n-->\n\n\`\`\`bash\necho hi\n\`\`\`\n`);
  add('a ticked box', '# T\n\n- [x] Told the team\n- [ ] Not yet\n\n```bash\necho hi\n```\n');
  add('a ticked box in a fence', '# T\n\n```bash\n- [x] echo hi\n```\n');
  // Stored output, as written and not.
  add('stored output as written', '# T\n\n```bash\necho hi\n```\n\n<!-- md-runbook:output start ran=2026-11-16T10:00:00Z exit=0 -->\n```text\nhi\n```\n<!-- md-runbook:output end -->\n');
  add('stored output with an indented fence', '# T\n\n```bash\necho hi\n```\n\n<!-- md-runbook:output start ran=2026-11-16T10:00:00Z exit=0 -->\n    ```text\n# shown as a heading\n    ```\n<!-- md-runbook:output end -->\n');
  // Fences: indentation and kinds.
  for (const [what, ind] of [['1 space', ' '], ['3 spaces', '   '], ['4 spaces', '    '], ['a tab', '\t'], ['2 spaces and a tab', '  \t']]) {
    add(`a fence indented ${what}`, `# T\n\n${ind}\`\`\`bash\n${ind}echo hi\n${ind}\`\`\`\n`);
    add(`a closing fence indented ${what}`, `# T\n\n\`\`\`bash\necho hi\n${ind}\`\`\`\n`);
  }
  add('a list item fence', '1. Step\n\n   ```bash\n   echo hi\n   ```\n');
  add('a longer closing fence', '```bash\necho hi\n`````\n');
  add('a shorter closing fence', '````bash\necho hi\n```\necho still code\n````\n');
  add('an unclosed fence', '# T\n\n```bash\necho hi\n');
  add('a backtick in the info string', '```bash `x`\necho hi\n```\n```bash\necho two\n```\n');
  add('a tilde fence', '~~~bash\necho hi\n~~~\n');
  add('a fence closed by the other kind', '```bash\necho hi\n~~~\necho still\n```\n');
  // HTML blocks.
  for (const [what, open, close] of [
    ['type 7 open tag', '<span>', ''],
    ['type 7 tag with attributes', '<a name="x" hidden>', ''],
    ['type 7 custom element', '<x-y hidden>', ''],
    ['type 7 closing tag', '</span>', ''],
    ['type 7 self-closing', '<br/>', ''],
    ['type 6 div', '<div>', '</div>'],
    ['type 1 pre', '<pre>', '</pre>'],
    ['type 1 script', '<script>', '</script>'],
    ['type 2 comment', '<!--', '-->'],
    ['type 3 processing instruction', '<?x', '?>'],
    ['type 4 declaration', '<!X', '>'],
    ['type 5 CDATA', '<![CDATA[', ']]>'],
  ]) {
    add(`a bash fence in an HTML block (${what})`, `# T\n\n${open}\n\`\`\`bash\necho hidden\n\`\`\`\n${close}\n\n\`\`\`bash\necho shown\n\`\`\`\n`);
  }
  add('a type 7 tag after a paragraph', '# T\n\nSome text\n<span>\n```bash\necho hi\n```\n');
  add('a type 7 tag indented 4 spaces', '# T\n\n    <span>\n```bash\necho hi\n```\n');
  // Cells whose text the manifest can't hold as clients read it.
  add('a NUL in a cell', '```bash\necho a\0b\n```\n');
  add('a BOM inside a cell', '```bash\n\ufeffecho hi\n```\n');
  add('a NUL in an info string', '```bash name=a\0b\necho hi\n```\n');
  add('kube-context= twice', '```bash kube-context=prod-eu kube-context=lab-1\necho hi\n```\n');
  add('kube-context= with a no-break space', '```bash kube-context="\u00a0prod-eu"\necho hi\n```\n');
  add('a reserved env.*', '```bash env.Https_Proxy=http://x\necho hi\n```\n');
  add('env.__proto__ on a block', '```bash env.__proto__=x env.constructor=y\necho hi\n```\n');
  add('a pattern that leaves the anchors', '```bash\necho ${param:TARGET}\n```\n', { ...META, patterns: { TARGET: 'a)|(b' } });
  add('a backslash in brackets', '```bash\necho ${param:TARGET}\n```\n', { ...META, patterns: { TARGET: '[A-Za-z0-9_\\-]+' } });
  add('a reserved parameter', '```bash\necho ${param:no_proxy}\n```\n', { ...META, patterns: { ...META.patterns, no_proxy: '.*' } });
  // Signature blocks: version 1 (blocks only) and 2 (the whole text).
  const BODY = '---\nmode: session\n---\n\n# T\n\n```bash\necho hi\n```\n';
  for (const v of [1, 2]) {
    const built = c.signing.buildManifest(BODY, META, { version: v });
    const signed = c.signing.withSignature(BODY, { signer: 'ops@example.net', signed: '2026-11-16', manifest: c.signing.formatManifest(built.manifest), signature: SIG });
    add(`signed, manifest version ${v}`, signed);
    add(`signed v${v}, front matter changed`, signed.replace('mode: session', 'mode: isolated'));
    add(`signed v${v}, a block added`, signed.replace('```bash\necho hi\n```\n', '```bash\necho hi\n```\n\n```bash\necho more\n```\n'));
    add(`signed v${v}, prose changed`, signed.replace('# T', '# Changed'));
    add(`signed v${v}, a note added`, signed.replace('# T\n', `# T\n\n${NOTE}`));
    add(`signed v${v}, the signature inside a fence`, '```text\n' + signed + '```\n');
  }
  return t;
}

/** Line endings and BOM, applied to a template written with LF. */
const EOLS = [
  ['LF', (s) => s],
  ['CRLF', (s) => s.replace(/\n/g, '\r\n')],
  ['CR', (s) => s.replace(/\n/g, '\r')],
  ['mixed', (s) => { let i = 0; return s.replace(/\n/g, () => ['\r\n', '\n', '\r'][i++ % 3]); }],
];

function runbookReading(c, text, meta) {
  const fm = c.secrets.parseFrontMatter(text);
  const cells = c.parser.parse(text).cells.filter((cell) => cell.kind === 'code').map((cell) => ({ lang: cell.languageId, info: cell.meta.info }));
  const sig = c.signing.readSignature(text);
  const status = c.signing.signedStatus(text);
  const built = c.signing.buildManifest(text, meta);
  const lint = c.lint
    .lintRunbook(text)
    .filter((p) => /front matter report-runs|kube-context/.test(p.message))
    .map((p) => `${p.severity} ${p.line}: ${p.message}`);
  return {
    frontMatter: fm === undefined ? null : JSON.parse(JSON.stringify(fm)),
    frontMatterLines: c.secrets.frontMatterLines(text) ?? null,
    cells,
    signedText: str(c, c.signing.signedText(text)),
    signature: sig ? { signer: sig.signer, manifest: str(c, sig.manifest) } : null,
    status: status ? { version: status.version, textChanged: status.textChanged, signed: [...status.cells.keys()], changed: status.changed, whole: c.signing.wholeRunbookSigned(status) } : null,
    lint,
    ...('errors' in built ? { errors: built.errors } : { manifest: c.signing.formatManifest(built.manifest), reading: manifestReading(c, c.signing.formatManifest(built.manifest)) }),
  };
}

// ---- requests: as the clients (packages/ssh) write them ----

const ID = '0123456789abcdef';

function requestVectors(c) {
  const ssh = c.ssh;
  const out = [];
  const add = (id, input, core) => out.push({ kind: 'request', id, input, core });
  const manifest = joinLines(BASE_LINES);
  add('load, one signature', ssh.gateLoadCommand(ID, manifest, SIG), { verb: 'load', manifest, signatures: 1 });
  add('load, five signatures', ssh.gateLoadCommand(ID, manifest, [SIG, SIG, SIG, SIG, SIG]), { verb: 'load', manifest, signatures: 5 });
  for (const [name, value] of [['TARGET', 'web'], ['TARGET', ''], ['TARGET', 'a b'], ['TARGET', 'caf\u00e9'], ['TARGET', 'a\rb'], ['TARGET', 'a\nb'], ['TARGET', 'a\0b'], ['TARGET', '\ufeffa'], ['TARGET', ' web '], ['_x1', 'v']]) {
    add(`param ${name}=${JSON.stringify(value)}`, ssh.gateParamCommand(ID, name, value), { verb: 'param', name, value, oneLine: c.signing.isOneLineValue(value) });
  }
  for (const [cell, step] of [[1, undefined], [2, 0], [2, 1], [999999, undefined], [1, 999999], [12, 3]]) {
    add(`run cell ${cell}${step === undefined ? '' : ` step ${step}`}`, ssh.gateRunCommand(ID, cell, step), step === undefined ? { verb: 'run', cell: String(cell) } : { verb: 'step', cell: String(cell), step: String(step) });
  }
  add('called', ssh.gateCalledCommand(ID, T64, 2), { verb: 'called', hash: T64, call: '2' });
  add('context', ssh.gateContextCommand(ID), { verb: 'context' });
  for (const text of ['echo hi\n', '', 'printf "a\\tb"\r\n', '\u00e9\0']) add(`raw ${JSON.stringify(text)}`, ssh.gateRawCommand(ID, text), { verb: 'raw', text });
  // Notes: every alert, as gateAlertNote cleans it, must be one the gate takes as it is.
  const names = ['HighCPU', '  High  CPU  ', 'a\tb\nc\rd\0e\x7ff', '\u00e9t\u00e9 \u{1F525}', 'x'.repeat(400), 'x'.repeat(401), '\u00e9'.repeat(200), '\u00e9'.repeat(201), 'x' + '\u{1F525}'.repeat(100), '\u{1F525}'.repeat(101), '', '   ', '\n', 'a\u2028b', 'a\u0085b', '\ufeff'];
  const fps = [undefined, 'abc123', 'a.b_c:d-e', 'a b', 'x'.repeat(128), 'x'.repeat(129), '', ' abc ', 'caf\u00e9'];
  const ats = [undefined, '2026-11-16T10:00:00Z', '2026-11-16 10:00', '2026-11-16t10:00:00.123456789+02:00', '2026-11-16T10:00:00.1234567890Z', '2026-11-16T10:00:00+0200', '2026-11-16', 'yesterday', ' 2026-11-16T10:00:00Z '];
  names.forEach((name, i) => {
    const alert = { name, fingerprint: fps[i % fps.length], startsAt: ats[i % ats.length] };
    const note = ssh.gateAlertNote(alert);
    // No name left: no note is sent (the gate would refuse an empty one).
    if (!note) return;
    add(`note ${i}: ${JSON.stringify(name).slice(0, 40)}`, ssh.gateNoteCommand(ID, note), { verb: 'note', alert: note.name, fingerprint: note.fingerprint ?? '', startsAt: note.startsAt ?? '' });
  });
  for (const fp of fps) for (const at of ats) {
    const note = ssh.gateAlertNote({ name: 'A', fingerprint: fp, startsAt: at });
    add(`note fingerprint ${JSON.stringify(fp)} starts ${JSON.stringify(at)}`, ssh.gateNoteCommand(ID, note), { verb: 'note', alert: note.name, fingerprint: note.fingerprint ?? '', startsAt: note.startsAt ?? '' });
  }
  for (const v of out) if (v.kind === 'request' && !v.input.endsWith('\n')) throw new Error(`a request without its newline: ${v.id}`);
  return out;
}

/**
 * Request lines by length: up to GATE_MAX_LINE bytes the gate reads one, a byte more ends the
 * session. The longest load request a signable manifest makes stays under it (with five
 * signatures of 2,048 base64 characters, more than an RSA 4096 SSHSIG).
 */
function lengthVectors(c) {
  const max = c.signing.GATE_MAX_LINE;
  const longestLoad = 'load '.length + 64 + 1 + Math.ceil(c.signing.MAX_MANIFEST_BYTES / 3) * 4 + 5 * (1 + 2048);
  if (longestLoad > max) throw new Error(`the longest load request (${longestLoad}) is over the gate's ${max}`);
  const out = [];
  for (const n of [0, 1, 1000, max - 1, max, max + 1, 2 * max]) {
    // `raw ID ` and base64 filling the rest, then the newline.
    const head = `raw ${ID} `;
    out.push({ kind: 'length', id: `a request of ${n} bytes`, input: { parts: [[head, 1], ['A', Math.max(0, n - head.length)], ['\n', 1]] }, core: { bytes: Math.max(n, head.length), read: Math.max(n, head.length) <= max } });
  }
  out.push({ kind: 'length', id: 'no request: empty input', input: '', core: { bytes: 0, read: false } });
  out.push({ kind: 'length', id: 'no request: a last line without its newline', input: `context ${ID}`, core: { bytes: `context ${ID}`.length, read: false } });
  out.push({ kind: 'length', id: 'an empty line', input: '\n', core: { bytes: 0, read: true } });
  return out;
}

// ---- the file ----

function generate() {
  const c = load();
  const vectors = [];
  for (const { id, input } of manifestInputs()) vectors.push({ kind: 'manifest', id, input, core: manifestReading(c, input) });
  const idOf = (s) => {
    const q = JSON.stringify(s).slice(1, -1);
    return q.length <= 80 ? q : `${q.slice(0, 60)}... (${s.length} characters)`;
  };
  for (const input of infoInputs()) vectors.push({ kind: 'info', id: idOf(input), input, core: infoReading(c, input) });
  for (const input of patternInputs()) vectors.push({ kind: 'pattern', id: idOf(input), input, core: patternReading(c, input) });
  for (const input of nameInputs(c)) vectors.push({ kind: 'name', id: JSON.stringify(input).slice(1, -1), input, core: nameReading(c, input) });
  for (const t of runbookTemplates(c)) {
    for (const bom of [false, true]) {
      for (const [eol, f] of EOLS) {
        const input = (bom ? '\ufeff' : '') + f(t.text);
        vectors.push({ kind: 'runbook', id: `${t.id} (${eol}${bom ? ', BOM' : ''})`, input, meta: t.meta, core: runbookReading(c, input, t.meta) });
      }
    }
  }
  vectors.push(...requestVectors(c), ...lengthVectors(c));
  // Long inputs as parts, so the file stays small.
  for (const v of vectors) {
    if (typeof v.input === 'string' && v.input.length > 4096) v.input = compress(v.input);
  }
  return {
    about: 'Shared test vectors of md-runbook-gate and its clients: core reads each input (core), the gate must read it the same (apps/gate/internal/vectors). Written by scripts/gate-vectors.js (npm run gate-vectors); do not edit.',
    counts: vectors.reduce((n, v) => ({ ...n, [v.kind]: (n[v.kind] ?? 0) + 1 }), {}),
    vectors,
  };
}

/**
 * A long string as [text, times] parts: a unit of 1 to 4 characters repeated to 64 characters or
 * more is one part (base64 of a repeated character repeats every 4).
 */
function compress(s) {
  const parts = [];
  let i = 0;
  let plain = '';
  while (i < s.length) {
    let best = 0;
    let unit = 1;
    for (let p = 1; p <= 4; p++) {
      let j = i + p;
      while (j + p <= s.length && s.startsWith(s.slice(i, i + p), j)) j += p;
      if (j - i > best) [best, unit] = [j - i, p];
    }
    if (best >= 64) {
      if (plain) parts.push([plain, 1]);
      plain = '';
      parts.push([s.slice(i, i + unit), best / unit]);
      i += best;
    } else plain += s[i++];
  }
  if (plain) parts.push([plain, 1]);
  return { parts };
}

/** The file: one vector per line, every control and non-ASCII character escaped (\uXXXX). */
function format(data) {
  const esc = (json) => json.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const head = { about: data.about, counts: data.counts };
  return (
    esc(JSON.stringify(head, null, 1)).replace(/\n}$/, ',\n "vectors": [\n') +
    data.vectors.map((v) => '  ' + esc(JSON.stringify(v))).join(',\n') +
    '\n ]\n}\n'
  );
}

module.exports = { generate, format, FILE };

if (require.main === module) {
  const text = format(generate());
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
    if (now !== text) {
      process.stderr.write(`${FILE} is not as core reads the vectors now: run npm run gate-vectors\n`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, text);
    process.stdout.write(`${FILE}: ${JSON.parse(text).vectors.length} vectors\n`);
  }
}

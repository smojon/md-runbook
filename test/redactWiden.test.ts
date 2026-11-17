/**
 * The widened patterns (0.30): quoted header values, Unicode spaces as blanks, passwords given to
 * tools, spaced key names. What they add is only added: the redactor and the leak scan still find
 * everything they found, at the same place and with the same name, on the random corpora and the
 * repository's files. In the leak scan, on runbook source too, a new finding needs a value that
 * looks like a secret (looksLikeSecret), so the repository's docs and examples get no new warning.
 * WIDEN_CORPUS_LINES sets the corpus size (default 30,000 lines per corpus).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { LeakFinding, looksLikeSecret, scanForLeaks } from '@md-runbook/core/leaks';
import { DEFAULT_PATTERNS, WIDENED_PATTERN_NAMES, createRedactor } from '@md-runbook/core/redact';
import { corpus, k8sCorpus, kubeCorpus } from './redactCorpus';

const LINES = Number(process.env.WIDEN_CORPUS_LINES ?? 30_000);
const ROOT = path.join(__dirname, '..', '..');
const R = '[REDACTED]';
const NBSP = String.fromCharCode(0xa0);
const IDEO = String.fromCharCode(0x3000);

const redactor = createRedactor(DEFAULT_PATTERNS);
const before = createRedactor(DEFAULT_PATTERNS.filter((p) => !WIDENED_PATTERN_NAMES.has(p.name ?? '')));
const widened = createRedactor(DEFAULT_PATTERNS.filter((p) => WIDENED_PATTERN_NAMES.has(p.name ?? '')));

const kinds = (text: string): string[] => scanForLeaks(text).map((f) => f.kind);

describe('what the widened patterns catch', () => {
  const cases: Array<[string, string, string]> = [
    // quoted header values
    ['JSON Authorization', '{"Authorization": "Basic dXNlcjpwYXNz"}', `{"Authorization": "${R}"}`],
    ['quoted Authorization', 'Authorization: "Basic dXNlcjpwYXNz"', `Authorization: "${R}"`],
    ['quoted Bearer', "'Authorization': 'Bearer abc.def'", `'Authorization': '${R}'`],
    ['quoted Token', 'Authorization = "Token abcdef"', `Authorization = "${R}"`],
    ['JSON Cookie', '{"Cookie": "session=abc123"}', `{"Cookie": "${R}"}`],
    ['Set-Cookie', "{'set-cookie': 'id=1; HttpOnly'}", `{'set-cookie': '${R}'}`],
    // Unicode spaces
    ['no-break space after key:', `password:${NBSP}hunter2`, `password:${NBSP}${R}`],
    ['ideographic space after key =', `token =${IDEO}abc123`, `token =${IDEO}${R}`],
    ['no-break space after a flag', `--password${NBSP}hunter2`, `--password${NBSP}${R}`],
    ['no-break space after Bearer', `Authorization:${NBSP}Bearer${NBSP}abc.def-1`, `Authorization:${NBSP}${R}`],
    // tools
    ['sshpass -p', 'sshpass -p s3cret ssh host', `sshpass -p ${R} ssh host`],
    ['sshpass -p quoted', "sshpass -p 'a b' ssh host", `sshpass -p ${R} ssh host`],
    ['redis-cli -a', 'redis-cli -a s3cret ping', `redis-cli -a ${R} ping`],
    ['ldapsearch -w', 'ldapsearch -x -D cn=admin -w s3cret', `ldapsearch -x -D cn=admin -w ${R}`],
    ['smbclient -U user%pass', 'smbclient //h/s -U bob%s3cret', `smbclient //h/s -U bob%${R}`],
    ['lftp -u user,pass', 'lftp -u bob,s3cret ftp://h', `lftp -u bob,${R} ftp://h`],
    ['openssl -passin pass:', 'openssl rsa -passin pass:s3cret -in k', `openssl rsa -passin pass:${R} -in k`],
    ['mysqldump -pPASS', 'mysqldump -u root -ps3cret db', `mysqldump -u root -p${R} db`],
    ['htpasswd -b', 'htpasswd -b .htpasswd bob s3cret', `htpasswd -b .htpasswd bob ${R}`],
    ['htpasswd -nb', 'htpasswd -nbB bob s3cret', `htpasswd -nbB bob ${R}`],
    ['7z -pPASS', '7z a -ps3cret a.7z dir', `7z a -p${R} a.7z dir`],
    ['zip -P', 'zip -P s3cret a.zip f', `zip -P ${R} a.zip f`],
    ['curl -U (proxy)', 'curl -U bob:s3cret https://x', `curl -U bob:${R} https://x`],
    ['cmdkey /pass:', 'cmdkey /generic:x /user:bob /pass:s3cret', `cmdkey /generic:x /user:bob /pass:${R}`],
    ['xfreerdp /p:', 'xfreerdp /v:h /u:bob /p:s3cret', `xfreerdp /v:h /u:bob /p:${R}`],
    ['nmcli password', 'nmcli dev wifi connect Home password s3cret', `nmcli dev wifi connect Home password ${R}`],
    ['keytool -storepass', 'keytool -list -keystore k.jks -storepass s3cret', `keytool -list -keystore k.jks -storepass ${R}`],
    ['sqlcmd -P', 'sqlcmd -S db -U sa -P s3cret', `sqlcmd -S db -U sa -P ${R}`],
    ['mongosh -p', 'mongosh -u admin -p s3cret', `mongosh -u admin -p ${R}`],
    ['snmpwalk -A -X', 'snmpwalk -v3 -A authpw1 -X privpw1 h', `snmpwalk -v3 -A ${R} -X ${R} h`],
    // where a command starts (review of 0.30): after a separator, sudo, env, exec, `--`, a path
    ['sudo sshpass', 'sudo sshpass -p s3cret scp f h:', `sudo sshpass -p ${R} scp f h:`],
    ['after a pipe', 'echo x | sshpass -p s3cret ssh h', `echo x | sshpass -p ${R} ssh h`],
    ['after &&', 'cd /tmp && redis-cli -a s3cret ping', `cd /tmp && redis-cli -a ${R} ping`],
    ['in $(…)', 'X=$(redis-cli -a s3cret get k)', `X=$(redis-cli -a ${R} get k)`],
    ['env VAR=value', 'env LANG=C sshpass -p s3cret ssh h', `env LANG=C sshpass -p ${R} ssh h`],
    ['a path', '/usr/bin/sshpass -p s3cret ssh h', `/usr/bin/sshpass -p ${R} ssh h`],
    ['docker exec', 'docker exec -it mongo mongosh -u admin -p s3cret', `docker exec -it mongo mongosh -u admin -p ${R}`],
    ['kubectl exec --', 'kubectl exec redis-0 -- redis-cli -a s3cret ping', `kubectl exec redis-0 -- redis-cli -a ${R} ping`],
    ['a | in quotes', 'ldapsearch -x -b "dc=x" "(|(uid=a)(uid=b))" -w s3cret', `ldapsearch -x -b "dc=x" "(|(uid=a)(uid=b))" -w ${R}`],
    ['inline code', 'Run `sshpass -p s3cret ssh h` first.', `Run \`sshpass -p ${R} ssh h\` first.`],
    // Windows tools in any case
    ['SCHTASKS /RP', 'SCHTASKS /Create /RU bob /RP s3cret', `SCHTASKS /Create /RU bob /RP ${R}`],
    ['schtasks /rp', 'schtasks /create /ru bob /rp s3cret', `schtasks /create /ru bob /rp ${R}`],
    ['CMDKEY /PASS:', 'CMDKEY /generic:x /user:bob /PASS:s3cret', `CMDKEY /generic:x /user:bob /PASS:${R}`],
    ['PsExec.exe', 'C:\\Tools\\PsExec.exe \\\\h -u bob -p s3cret cmd', `C:\\Tools\\PsExec.exe \\\\h -u bob -p ${R} cmd`],
    // spaced key names
    ['api key:', 'api key: abc123', `api key: ${R}`],
    ['Secret Key = "…"', 'Secret Key = "a b c"', `Secret Key = "${R}"`],
    ['access key', 'AWS access key: AKIAx', `AWS access key: ${R}`],
    ['passphrase', 'passphrase: s3cret', `passphrase: ${R}`],
  ];
  for (const [name, input, expected] of cases) it(name, () => assert.equal(redactor.redact(input), expected));

  it('leaves alone what is no password', () => {
    for (const s of [
      'ssh -p 22 host',
      'psql -h db -p 5432',
      'mysqldump -u root -p db',
      'scp -P 2222 f host:',
      'sshpass -f pwfile ssh host',
      'zip -r a.zip dir',
      'curl -u ${USER}:${PASS} https://x',
      'redis-cli -h h ping',
      'api monkey: x',
      'api keys: none',
      'openssl rsa -passin env:PW -in k',
      'htpasswd -c .htpasswd bob',
      // a tool's name elsewhere than where a command starts, or its flag in the next command (review of 0.30)
      'docker run -d --name mongo -p 27017:27017 mongo:7',
      'ssh mongo-1 -p 2222',
      'wget https://x.example/app.zip -P /tmp/dl',
      'ldapsearch -x -b dc=x uid | grep -w uid',
      'openssl s_client -connect h:443 ; curl -k https://h/health',
      'echo $X | sshpass -d 3 ssh h; psql -h db -p 5432',
      'ldapsearch -x -b dc=x || grep -w uid f',
      'mongosh --eval x && ssh h -p 2222',
      'cat notes.txt # sshpass\nssh h -p 2222',
    ]) {
      assert.equal(redactor.redact(s), before.redact(s), s);
      assert.deepEqual(kinds(s), scanForLeaks(s, { widened: false }).map((f) => f.kind), s);
    }
  });

  it('reports in the leak scan only values that look like secrets', () => {
    assert.deepEqual(kinds('sshpass -p s3cret ssh host'), ['password-flag-tool']);
    assert.deepEqual(kinds('{"Authorization": "Basic dXNlcjpwYXNz"}'), ['authorization-header-quoted']);
    assert.deepEqual(kinds('api key: aZ9xQ2mP'), ['secret-key-value-spaced']);
    for (const s of ['api key: see vault', 'API key: <your key>', 'sshpass -p ${SSHPASS} ssh h', 'secret key: changeme', 'api key: xxxxxx', 'sshpass -p 22 ssh h']) {
      assert.deepEqual(kinds(s), [], s);
    }
    assert.equal(looksLikeSecret('"abcd"', 0, 6), true);
    assert.equal(looksLikeSecret('hunter2', 0, 7), true);
    assert.equal(looksLikeSecret('vault', 0, 5), false);
    assert.equal(looksLikeSecret('"your-token"', 0, 12), false);
  });
});

const same = (a: LeakFinding, b: LeakFinding): boolean => a.offset === b.offset && a.length === b.length && a.kind === b.kind;

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  if (fs.statSync(dir).isFile()) return [...out, dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') filesUnder(f, out);
    } else if (/\.(?:md|ts|tsx|json|ya?ml|sh)$/.test(e.name) && fs.statSync(f).size < 1_000_000) out.push(f);
  }
  return out;
}

/** Compare old and new on `text`: every old finding and redaction kept; the new findings counted by kind. */
function compare(text: string, added: Map<string, string[]>, where: string): void {
  const old = scanForLeaks(text, { widened: false });
  const now = scanForLeaks(text);
  for (const f of old) if (!now.some((g) => same(f, g))) assert.fail(`${where}: lost ${JSON.stringify(f)} in ${JSON.stringify(text.slice(0, 300))}`);
  for (const g of now) {
    if (old.some((f) => same(f, g))) continue;
    const list = added.get(g.kind) ?? [];
    if (list.length < 5) list.push(text.slice(Math.max(0, g.offset - 30), g.offset + g.length + 10));
    else list.push('');
    added.set(g.kind, list);
  }
  // The redactor: the widened patterns run on what the others left, so nothing they hid shows.
  assert.equal(redactor.redact(text), widened.redact(before.redact(text)), where);
}

describe('only added: old findings and redactions kept', () => {
  it(`on ${LINES.toLocaleString('en')} lines of each corpus`, (t) => {
    const added = new Map<string, string[]>();
    for (const text of corpus(11, LINES)) compare(text, added, 'redaction corpus');
    for (const text of k8sCorpus(12, LINES)) compare(text, added, 'kubernetes corpus');
    for (const text of kubeCorpus(13, LINES)) compare(text, added, 'kubectl corpus');
    t.diagnostic(`new findings: ${[...added].map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    for (const [k, v] of added) t.diagnostic(`${k}: ${JSON.stringify(v.filter((x) => x !== '').slice(0, 3))}`);
    for (const k of WIDENED_PATTERN_NAMES) assert.ok((added.get(k)?.length ?? 0) > 0, `${k} found nothing new`);
  });

  it('on the repository’s files, where the docs and examples get no new warning', (t) => {
    const added = new Map<string, string[]>();
    const docs = new Map<string, string[]>();
    for (const f of ['docs', 'examples', 'walkthrough', 'README.md', 'CHANGELOG.md', 'test', 'apps/mobile/src/__tests__'].flatMap((d) => filesUnder(path.join(ROOT, d)))) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      const here = new Map<string, string[]>();
      compare(text, here, rel);
      for (const [k, v] of here) added.set(k, [...(added.get(k) ?? []), ...v]);
      if (!rel.startsWith('test/') && !rel.startsWith('apps/')) for (const [k, v] of here) docs.set(`${rel} ${k}`, v);
    }
    t.diagnostic(`new findings in the repository (tests): ${[...added].map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    for (const [k, v] of added) t.diagnostic(`${k}: ${JSON.stringify(v.filter((x) => x !== '').slice(0, 3))}`);
    // Docs, examples, the walkthrough, README and CHANGELOG: no new warning.
    assert.deepEqual([...docs], []);
  });
});

const BUDGET_MS = Number(process.env.REDACT_BUDGET_MS ?? 2_000);
const N = 200_000;
const rep = (s: string, n = N): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const HOSTILE = [
  NBSP.repeat(N),
  rep(`password:${NBSP}`),
  'sshpass' + rep(' -p'),
  rep('sshpass -p '),
  rep(' -ps'),
  'smbclient' + rep(' -U a%'),
  rep('a%'),
  'lftp' + rep(' -u a,'),
  'openssl' + rep(' -passin pass:'),
  rep('htpasswd -b '),
  'htpasswd -b' + rep(' a'),
  rep('api key: '),
  rep('api  '),
  'api' + ' '.repeat(N) + 'key: x',
  rep('"Authorization": "'),
  rep("Cookie: '"),
  rep('pass phrase'),
  'mysqldump' + rep(' -p'),
];

describe('the widened patterns stay linear on 200,000-character lines', () => {
  it('each of them, and the leak scan', () => {
    for (const p of DEFAULT_PATTERNS.filter((x) => WIDENED_PATTERN_NAMES.has(x.name ?? ''))) {
      const r = createRedactor([p]);
      const t0 = performance.now();
      for (const line of HOSTILE) r.redact(line);
      const ms = performance.now() - t0;
      // secret-after-unicode-space is eight patterns in one.
      assert.ok(ms < (p.name === 'secret-after-unicode-space' ? 4 : 1) * BUDGET_MS, `${p.name}: ${Math.round(ms)} ms`);
    }
    const t0 = performance.now();
    for (const line of HOSTILE) scanForLeaks(line);
    assert.ok(performance.now() - t0 < 4 * BUDGET_MS, `scanForLeaks: ${Math.round(performance.now() - t0)} ms`);
  });
});

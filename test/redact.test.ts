import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_PATTERNS, createRedactor } from '@md-runbook/core';
import { redactLeaks } from '@md-runbook/core/leaks';

const r = createRedactor(DEFAULT_PATTERNS);
const R = '[REDACTED]';

describe('default redaction patterns', () => {
  it('compile without errors', () => assert.deepEqual(r.errors, []));

  const cases: Array<[string, string, string]> = [
    ['bearer token', 'curl -H "Authorization: Bearer abc.def-ghi"', `curl -H "Authorization: ${R}"`],
    ['bare bearer', 'token type Bearer sk_live_123/abc==', `token type Bearer ${R}`],
    ['authorization basic', '> Authorization: Basic dXNlcjpwYXNz\r\n', `> Authorization: ${R}\r\n`],
    ['proxy-authorization', 'Proxy-Authorization: Negotiate YII=', `Proxy-Authorization: ${R}`],
    ['cookie header', '> Cookie: session=abc; csrftoken=def', `> Cookie: ${R}`],
    ['set-cookie header', '< set-cookie: id=1; HttpOnly', `< set-cookie: ${R}`],
    [
      'JWT',
      'id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk end',
      `id_token ${R} end`,
    ],
    ['password key=value', 'password=hunter2 next', `password=${R} next`],
    ['json secret', '{"client_secret": "s3cr3t", "x": 1}', `{"client_secret": "${R}", "x": 1}`],
    ['yaml token', 'data:\n  token: c2VjcmV0\n  name: x', `data:\n  token: ${R}\n  name: x`],
    ['env var', 'export API_KEY=abc123', `export API_KEY=${R}`],
    ['cli flag', 'oc login --token=sha256~abcdefghijklmnopqrstuvwxyz0123 --server=x', `oc login --token=${R} --server=x`],
    ['query string', 'GET /cb?access_token=abc&state=1', `GET /cb?access_token=${R}&state=1`],
    ['url credentials', 'git clone https://user:p%40ss@github.com/x', `git clone https://user:${R}@github.com/x`],
    ['openshift token alone', 'sha256~abcdefghijklmnopqrstuvwxyz0123', R],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE', R],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', R],
    // escaped JSON: the key's and the value's quotes escaped (review of 0.30)
    ['escaped JSON key', '{\\"password\\":\\"hunter2\\"}', `{\\"password\\":\\"${R}\\"}`],
    ['JSON in a JSON string', 'log line {"cfg":"{\\"db_password\\":\\"hunter2\\"}"}', `log line {"cfg":"{\\"db_password\\":\\"${R}\\"}"}`],
    ['escaped JSON, spaces', '{\\"api_key\\" : \\"a b c\\", \\"x\\": 1}', `{\\"api_key\\" : \\"${R}\\", \\"x\\": 1}`],
    ['escaped JSON header', '{\\"Authorization\\":\\"Basic dXNlcjpwYXNz\\"}', `{\\"Authorization\\":\\"${R}\\"}`],
    // an escaped quote inside a quoted value
    ['escaped quote in a value', '{"password": "abc\\"defgh"}', `{"password": "${R}"}`],
    // in '…' a backslash escapes nothing (sh, PowerShell): `'C:\keys\'` ends at its quote (final review of 0.30)
    ['backslash at the end in single quotes', "token: 'C:\\keys\\' next", `token: '${R}' next`],
    ['backslash before the line end', 'password = "pa ss\\"', `password = "${R}"`],
    ['escaped backslash at the end', '"secret": "abc\\\\", "x": 1', `"secret": "${R}", "x": 1`],
    // JSON escaped twice: `\\\"` is a quote in the value, `\\\\\"` a backslash then the end (second review of 0.30)
    ['escaped quote in escaped JSON', '{\\"password\\":\\"s3c\\\\\\"ret more\\"}', `{\\"password\\":\\"${R}\\"}`],
    ['escaped backslash in escaped JSON', '{\\"password\\":\\"s3c\\\\\\\\\\", \\"x\\":1}', `{\\"password\\":\\"${R}\\", \\"x\\":1}`],
    // a pass key's whole value in quotes, escaped too
    ['pass key, quoted value with a space', 'DB_PASS="p@ss w0rd"', `DB_PASS="${R}"`],
    ['pass key, escaped quoted value', 'DB_PASS=\\"p@ss w0rd\\"', `DB_PASS=\\"${R}\\"`],
    ['pass key in escaped JSON', '{\\"db_pass\\":\\"p@ss w0rd\\"}', `{\\"db_pass\\":\\"${R}\\"}`],
    // a URL with a password but no user
    ['url password, no user', 'REDIS_URL=redis://:s3cretPw@cache:6379', `REDIS_URL=redis://:${R}@cache:6379`],
    ['url password, no user, in text', 'connect to rediss://:s3cretPw@cache:6380/0 now', `connect to rediss://:${R}@cache:6380/0 now`],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(r.redact(input), expected));
  }

  it('PEM private keys (keeps the BEGIN/END lines)', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\n';
    assert.equal(r.redact(pem), `-----BEGIN RSA PRIVATE KEY-----${R}-----END RSA PRIVATE KEY-----\n`);
  });

  it('truncated PEM private key with no END line', () => {
    assert.equal(r.redact('-----BEGIN PRIVATE KEY-----\nMIIE\nabc'), `-----BEGIN PRIVATE KEY-----${R}`);
  });

  it('does not touch certificates or ordinary output', () => {
    const plain = [
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      'NAME      READY   STATUS',
      'secret/my-secret created',
      'kubectl get secrets -n iam',
      'password reset flow',
      'echo "hello world"',
    ].join('\n');
    assert.equal(r.redact(plain), plain);
  });

  it('does not run across lines for an empty value', () => {
    assert.equal(r.redact('password=\nnext line'), 'password=\nnext line');
  });

  it('is idempotent', () => {
    const once = r.redact('Authorization: Bearer x\npassword=y\neyJabcdefgh.ijklmnopq.rst');
    assert.equal(r.redact(once), once);
  });
});

describe('custom patterns', () => {
  it('accepts strings and objects, adds the g flag', () => {
    const c = createRedactor(['internal-[0-9]+', { pattern: 'abc', flags: 'i' }]);
    assert.deepEqual(c.errors, []);
    assert.equal(c.redact('internal-1 internal-22 ABC'), `${R} ${R} ${R}`);
  });

  it('reports invalid patterns and keeps the valid ones', () => {
    const c = createRedactor(['([', { name: 'ok', pattern: 'x' }]);
    assert.equal(c.errors.length, 1);
    assert.match(c.errors[0]!, /^\(\[:/);
    assert.equal(c.redact('x'), R);
  });

  it('ignores zero-length matches', () => {
    assert.equal(createRedactor(['a*']).redact('bab'), `b${R}b`);
  });

  it('match the same text as the built-in ones, and what overlaps is replaced once', () => {
    const c = createRedactor([...DEFAULT_PATTERNS, '\\bword=\\S+', 'hunter']);
    assert.equal(c.redact('password=hunter2 word=x'), `password=${R} ${R}`);
    assert.equal(c.redact('xhunter'), `x${R}`);
  });
});

describe('a quoted value that ends in a backslash (final review of 0.30)', () => {
  const B = '\\';
  const cases: Array<[string, string]> = [
    [`export DB_PASSWORD='p4ss${B}' DB_PASS='S3cretPw9'`, `export DB_PASSWORD='${R}' DB_PASS='${R}'`],
    [`$secretsDir = "C:${B}secrets${B}"; az login --password "S3cretPw9"`, `$secretsDir = "${R}"; az login --password ${R}`],
    [`PGPASSWORD='ab${B}' psql --password 'S3cretPw9'`, `PGPASSWORD='${R}' psql --password ${R}`],
    [`$env:TOKEN_DIR = "C:${B}tokens${B}"; $env:DB_PASS = "Hunter2secret"`, `$env:TOKEN_DIR = "${R}"; $env:DB_PASS = "${R}"`],
    [`password="ab${B}" token="xyz12345"`, `password="${R}" token="${R}"`],
    [`password: 'ab${B}' # then kc_pass: 'S3cretPw9'`, `password: '${R}' # then kc_pass: '${R}'`],
    [`mytool --password "abc${B}" | x --token "S3cretPw9"`, `mytool --password ${R} | x --token ${R}`],
    // `\"` before anything else is still an escaped quote
    [`{"password": "abc${B}"defgh"}`, `{"password": "${R}"}`],
    [`{${B}"password${B}":${B}"x${B}"}`, `{${B}"password${B}":${B}"${R}${B}"}`],
  ];
  for (const [input, expected] of cases) it(input, () => assert.equal(r.redact(input), expected));

  // Each kind of secret after a value that ends in a backslash: the first secret and the second both hidden.
  const firsts = [`$secretsDir = "C:${B}secrets${B}"; `, `export DB_PASSWORD='p4ss${B}' `, `PGPASSWORD='ab${B}' `, `password="ab${B}" `, `API_KEY='abc${B}' `, `DB_PASS="ab${B}" ; `];
  const seconds: Array<[string, string]> = [
    ["DB_PASS='S3cretPw9'", 'S3cretPw9'],
    ['API_TOKEN="S3cretPw9"', 'S3cretPw9'],
    ['client_secret: S3cretPw9', 'S3cretPw9'],
    ['az login --password "S3cretPw9"', 'S3cretPw9'],
    ["curl -u 'admin:S3cretPw9' https://x", 'S3cretPw9'],
    ['curl -u admin:S3cretPw9 https://x', 'S3cretPw9'],
    ["curl -H 'Authorization: Basic dXNlcjpTM2NyZXRQdzk='", 'dXNlcjpTM2NyZXRQdzk'],
    ["echo 'Cookie: session=S3cretPw9'", 'S3cretPw9'],
    ['curl -H "X: Bearer S3cretPw9.abc"', 'S3cretPw9'],
    ['git clone https://u:S3cretPw9@h/x', 'S3cretPw9'],
    ['sshpass -p S3cretPw9 ssh h', 'S3cretPw9'],
    ['redis-cli -a S3cretPw9 ping', 'S3cretPw9'],
    ['htpasswd -b f admin S3cretPw9', 'S3cretPw9'],
    ['mysql -pS3cretPw9 db', 'S3cretPw9'],
    ['echo "api key: S3cretPw9"', 'S3cretPw9'],
    ['echo ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['echo AKIAIOSFODNN7EXAMPLE', 'AKIA'],
    ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'eyJ'],
    ['echo \'{"type":"secret","value":"S3cretPw9"}\'', 'S3cretPw9'],
  ];
  it('then a second secret of each kind', () => {
    for (const first of firsts) {
      for (const [second, secret] of seconds) {
        const out = r.redact(first + second);
        assert.ok(!out.includes(secret), `${first + second} -> ${out}`);
        assert.ok(!/p4ss|ab\\|abc\\|C:\\secrets/.test(out), `${first + second} -> ${out}`);
      }
    }
  });
});

describe('a quoted value read over the next key’s value (0.30.0 review)', () => {
  const B = '\\';
  // The first value's `"…"` (or `\"…\"`) reading runs to a quote inside the second secret; that
  // secret's own `'…'` reading is found too (each quote's alternative on its own).
  const cases: Array<[string, string]> = [
    [`connect(password="C:${B}keys${B}", token='Kd4wD"Tn6vE')`, `connect(password="${R}')`],
    [`mytool --password="a${B}"b --token='Kd4wD" Tn6vE'`, `mytool --password="${R}'`],
    [`TOKEN=${B}"Zq9xA; aws_secret_access_key: 'Kd4wD${B}" Tn6vE Rp2uF'`, `TOKEN=${B}"${R}'`],
  ];
  for (const [input, expected] of cases) {
    it(input, () => {
      assert.equal(r.redact(input), expected);
      const leaks = redactLeaks(input);
      for (const secret of ['keys', 'Zq9xA', 'Kd4wD', 'Tn6vE', 'Rp2uF']) assert.ok(!leaks.includes(secret), `redactLeaks: ${leaks}`);
    });
  }

  // Each opening of the first value with each of the second, the second's value holding the first's quote.
  const firsts = [`password="a${B}"b `, `password=${B}"a `, `DB_PASS="a${B}"b `, `api key: "a${B}"b `, `password='a `];
  const seconds = [`token='Kd4wD"Tn6vE'`, `token='Kd4wD${B}" Tn6vE'`, `DB_PASS='Kd4wD" Tn6vE'`, `secret key: 'Kd4wD" Tn6vE'`, `token="Kd4wD' Tn6vE"`, `token=${B}'Kd4wD" Tn6vE${B}'`];
  it('each opening quote, then a second key whose value holds a quote', () => {
    for (const first of firsts) {
      for (const second of seconds) {
        const out = r.redact(first + second);
        assert.ok(!/Kd4wD|Tn6vE/.test(out), `${first + second} -> ${out}`);
      }
    }
  });
});

describe('text glued to a closing quote is part of the value', () => {
  const B = '\\';
  // A shell joins `'Kd4wD'Rp2uF` into one word: `Rp2uF` is part of the secret.
  const cases: Array<[string, string]> = [
    [`password='Kd4wD'Rp2uF`, `password='${R}`],
    [`password="Kd4wD"Rp2uF`, `password="${R}`],
    [`password='Kd4wD'Rp2uF next`, `password='${R} next`],
    [`password="Kd4wD"Rp2uF;echo`, `password="${R};echo`],
    // escaped: `\"…\"` in a string run by a shell
    [`sh -c "db --password=${B}"Kd4wD${B}"Rp2uF x"`, `sh -c "db --password=${B}"${R} x"`],
    [`{${B}"password${B}":${B}"Kd4wD${B}"Rp2uF}`, `{${B}"password${B}":${B}"${R}}`],
    // further segments: other quotes, doubled quotes, `'\''`
    [`password='Kd4wD'"Rp2uF"Tn6vE`, `password='${R}`],
    [`password: 'Kd4wD''Rp2uF'`, `password: '${R}`],
    [`password: 'Kd4wD''s Rp2uF'`, `password: '${R}`],
    [`password="Kd4wD""Rp2uF Tn6vE"`, `password="${R}`],
    [`password='Kd4wD'${B}''Rp2uF'`, `password='${R}`],
    [`password="Kd4wD"'Rp2uF'x.y`, `password="${R}`],
    // each family that reads a quoted value
    [`DB_PASS='Kd4wD'Rp2uF`, `DB_PASS='${R}`],
    [`api key: "Kd4wD"Rp2uF`, `api key: "${R}`],
    [`{"Authorization": "Basic Kd4wD"Rp2uF}`, `{"Authorization": "${R}}`],
    [`{"Cookie": 'id=Kd4wD'Rp2uF}`, `{"Cookie": '${R}}`],
    [`password:${String.fromCharCode(0xa0)}'Kd4wD'Rp2uF`, `password:${String.fromCharCode(0xa0)}'${R}`],
    [`curl -u 'admin:Kd4wD'Rp2uF https://x`, `curl -u 'admin:${R} https://x`],
    [`curl -u "admin:Kd4wD"Rp2uF https://x`, `curl -u "admin:${R} https://x`],
    [`--password 'Kd4wD'Rp2uF x`, `--password ${R} x`],
    [`--client-secret "Kd4wD"'Rp2uF' x`, `--client-secret ${R} x`],
    [`sshpass -p 'Kd4wD'Rp2uF ssh h`, `sshpass -p ${R} ssh h`],
    [`mysql -p'Kd4wD'Rp2uF db`, `mysql -p${R} db`],
    [`smbclient //h/s -U 'admin%Kd4wD'Rp2uF`, `smbclient //h/s -U 'admin%${R}`],
    [`openssl rsa -passin 'pass:Kd4wD'Rp2uF -in k`, `openssl rsa -passin 'pass:${R} -in k`],
    [`htpasswd -b f admin 'Kd4wD'Rp2uF`, `htpasswd -b f admin ${R}`],
    // a tail may start with `- @ ! % ~ ^ * = ? /` too, and hold `\X` pairs
    ...['-', '@', '!', '%', '~', '^', '*', '=', '?', '/'].map((c): [string, string] => [`password='Kd4wD'${c}Rp2uF`, `password='${R}`]),
    [`password='Kd4wD'Rp${B} 2uF next`, `password='${R} next`],
    [`<input password="Kd4wD"/>`, `<input password="${R}>`],
    // escaped values glue segments too: the inner shell reads `Kd4wDRp2uFTn6vE`
    [`sh -c "db --password=${B}"Kd4wD${B}"Rp2uF${B}"Tn6vE${B}" x"`, `sh -c "db --password=${B}"${R} x"`],
    [`sh -c "db --password=${B}"Kd4wD${B}"Rp2uF'Tn6vE' x"`, `sh -c "db --password=${B}"${R} x"`],
  ];
  for (const [input, expected] of cases) {
    it(input, () => {
      assert.equal(r.redact(input), expected);
      const leaks = redactLeaks(input);
      for (const secret of ['Kd4wD', 'Rp2uF', 'Tn6vE']) assert.ok(!leaks.includes(secret), `redactLeaks: ${leaks}`);
    });
  }

  // What follows a string in structured text, a blank or a word's end is kept.
  const kept: Array<[string, string]> = [
    [`{"password": "Kd4wD", "a": 1}`, `{"password": "${R}", "a": 1}`],
    [`{"password":"Kd4wD"}`, `{"password":"${R}"}`],
    [`[password='Kd4wD']`, `[password='${R}']`],
    [`password: 'Kd4wD' # c`, `password: '${R}' # c`],
    [`connect(password="Kd4wD")`, `connect(password="${R}")`],
    [`{${B}"password${B}":${B}"Kd4wD${B}",${B}"a${B}":1}`, `{${B}"password${B}":${B}"${R}${B}",${B}"a${B}":1}`],
    [`Connect -Password 'Kd4wD')`, `Connect -Password ${R})`],
    [`password='Kd4wD';echo`, `password='${R}';echo`],
    [`password='Kd4wD'|x`, `password='${R}'|x`],
    [`password='Kd4wD'`, `password='${R}'`],
    ['`password="Kd4wD"`', `\`password="${R}"\``],
    [`password="Kd4wD".`, `password="${R}".`],
    [`password="Kd4wD".encode()`, `password="${R}".encode()`],
    [`password='Kd4wD'+suffix`, `password='${R}'+suffix`],
    [`password: 'Kd4wD':x`, `password: '${R}':x`],
    // the closing quote of a string around the command
    [`{"cmd": "mysql -p'Kd4wD'", "x": "y"}`, `{"cmd": "mysql -p${R}", "x": "y"}`],
    [`ssh h "mysql -p'Kd4wD'" && echo "ok"`, `ssh h "mysql -p${R}" && echo "ok"`],
    [`args: ["--password='Kd4wD'","-v"]`, `args: ["--password='${R}'","-v"]`],
  ];
  for (const [input, expected] of kept) it(input, () => assert.equal(r.redact(input), expected));

  // A quote that opens the next value (after a key, a flag, `-u`, htpasswd's USER) is never glued
  // over: that value is still read from its start (review of the glued-tail fix).
  const next = [
    `password: 'Kd4wD'' token: 'Tn6vE Rp2uF'`,
    `password="Kd4wD""token="Rp2uF Tn6vE"`,
    `password='Kd4wD'${B}''token='Rp2uF Tn6vE'`,
    `Authorization: 'Kd4wD''Authorization: 'Bearer Rp2uF Tn6vE'`,
    `{"Authorization": "Kd4wD""Authorization": "Rp2uF Tn6vE"}`,
    `htpasswd -b f u 'Kd4wD''htpasswd -b f u 'Rp2uF Tn6vE'`,
    `--password 'Kd4wD'' --password 'Rp2uF Tn6vE'`,
    `redis-cli -a 'Kd4wD'' -a 'Rp2uF Tn6vE' ping`,
    `curl -u "admin:Kd4wD${B}"b -u "x:Rp2uF Tn6vE"`,
    `curl -u admin:'Kd4wD'' -u x:'Rp2uF Tn6vE'`,
    `password=Kd4wD'' token='Rp2uF Tn6vE'`,
    `password=Kd4wD'token='Rp2uF Tn6vE'`,
    `openssl rsa -passin "pass:Kd4wD${B}"b -passout "pass:Rp2uF Tn6vE"`,
    `smbclient //h/s -U "admin%Kd4wD${B}"b -U "x%Rp2uF Tn6vE"`,
    `password=${B}"Kd4wD${B}"x${B}"token=${B}"Rp2uF Tn6vE${B}"`,
  ];
  for (const input of next) {
    it(input, () => {
      const out = r.redact(input);
      assert.ok(!/Kd4wD|Rp2uF|Tn6vE/.test(out), `${input} -> ${out}`);
    });
  }
});

describe('escaped, ANSI-C and glued quotes (after 0.32)', () => {
  const B = '\\';
  const cases: Array<[string, string]> = [
    // a flag's value in escaped quotes: `sh -c "…"` or JSON
    [`sh -c "db --password ${B}"Kd4wD7${B}" --host x"`, `sh -c "db --password ${R} --host x"`],
    [`bash -c "mysql -p${B}"Kd4wD7${B}" -h x"`, `bash -c "mysql -p${R} -h x"`],
    [`sh -c "db --password=${B}"Kd4wD7${B}" --host x"`, `sh -c "db --password=${B}"${R}${B}" --host x"`],
    [`{"cmd":"db --password ${B}"Kd4wD7${B}" --host x"}`, `{"cmd":"db --password ${R} --host x"}`],
    [`sh -c "db --password ${B}"Kd4wD7${B}"Rp2uF x"`, `sh -c "db --password ${R} x"`],
    // -u user:'PASSWORD'
    [`curl -u admin:'Kd4wD7' https://x`, `curl -u admin:'${R}' https://x`],
    [`curl --user admin:'Kd4w D7' https://x`, `curl --user admin:'${R}' https://x`],
    [`curl -u admin:"Kd4wD7" https://x`, `curl -u admin:"${R}" https://x`],
    [`curl -u admin:'Kd4wD7'Rp2uF https://x`, `curl -u admin:'${R} https://x`],
    // bash's $'…' (ANSI-C quotes): `\'` and `\\` are escapes in it
    [`export PASSWORD=$'Kd4${B}'wD7 x'`, `export PASSWORD=$'${R}'`],
    [`mysql --password=$'Kd4wD7${B}n' -h x`, `mysql --password=$'${R}' -h x`],
    [`mysql --password $'Kd4wD7${B}n' -h x`, `mysql --password ${R} -h x`],
    [`sshpass -p $'Kd4 wD7' ssh h`, `sshpass -p ${R} ssh h`],
    [`mysql -p$'Kd4wD7' -h x`, `mysql -p${R} -h x`],
    [`DB_PASS=$'Kd4 wD7'`, `DB_PASS=$'${R}'`],
    // text glued before a quote: one shell word
    [`--password abc'Kd4wD7' x`, `--password ${R} x`],
    [`password=abc"Kd4wD7" x`, `password=${R} x`],
    [`curl -u admin:abc'Kd4wD7' x`, `curl -u admin:${R} x`],
    [`smbclient //h/s -U admin%abc'Kd4wD7'"Rp2uF" x`, `smbclient //h/s -U admin%${R} x`],
    // an empty value with glued text, a reference with glued text
    [`password=''Kd4wD7`, `password='${R}`],
    [`password=""Kd4wD7 x`, `password="${R} x`],
    [`--password '\${secret:X}'Kd4wD7`, `--password ${R}`],
    [`--password "$PW"Kd4wD7 x`, `--password ${R} x`],
    // sshpass reads `'a'' -p 'b` as one word: its own options are whole words
    [`sshpass -p 'Kd4wD7'' -p 'Rp2uF Tn6vE' ssh h`, `sshpass -p ${R} Tn6vE' ssh h`],
    // doubled quotes: the secret hidden, the closing quote with it (as before)
    [`$password = "Kd4""wD7 tail"`, `$password = "${R}`],
  ];
  for (const [input, expected] of cases) {
    it(input, () => {
      assert.equal(r.redact(input), expected);
      const leaks = redactLeaks(input);
      for (const secret of ['Kd4', 'wD7', 'Rp2uF']) assert.ok(!leaks.includes(secret), `redactLeaks: ${leaks}`);
    });
  }

  // What follows a string in structured text, a reference and an empty value stay.
  const kept = [
    `{"password": "", "a": 1}`,
    `password: '' # c`,
    `--password '\${secret:X}' x`,
    `--password $'\${secret:X}' x`,
    `password=$'\${secret:X}'`,
    `curl -u admin:'\${secret:pw}' https://x`,
    `curl -u admin:"$PW" https://x`,
    `sh -c "db --password=${B}"\${secret:X}${B}" x"`,
  ];
  for (const input of kept) it(input, () => assert.equal(r.redact(input), input));
  // A quote after a bare value that ends an enclosing string, or holds a blank, is not glued.
  const keptAfter: Array<[string, string]> = [
    [`{"cmd":"x --password abc", "y":"z"}`, `{"cmd":"x --password ${R}", "y":"z"}`],
    [`{"cmd":"x --password abc"}`, `{"cmd":"x --password ${R}"}`],
    [`args: ["x --password abc","-v"]`, `args: ["x --password ${R}","-v"]`],
    [`{"x":"password=abc","y":"z"}`, `{"x":"password=${R}","y":"z"}`],
    [`ssh h "mysql --password abc" && echo "ok"`, `ssh h "mysql --password ${R}" && echo "ok"`],
    [`echo 'curl -u a:abc' 'x'`, `echo 'curl -u a:${R}' 'x'`],
  ];
  for (const [input, expected] of keptAfter) it(input, () => assert.equal(r.redact(input), expected));
});

describe('redaction of real-world IAM/OpenShift output', () => {
  const cases: Array<[string, string, string]> = [
    ['flag with space', 'kcadm.sh config credentials --user admin --password Adm1n-Kc-Pw', `kcadm.sh config credentials --user admin --password ${R}`],
    ['oc login -p', 'oc login -u kubeadmin -p Xk9pass123Q https://api:6443', `oc login -u kubeadmin -p ${R} https://api:6443`],
    ['quoted flag value', '--client-secret "a b c"', `--client-secret ${R}`],
    ['quoted key value with spaces', 'password = "Hunter 2 with spaces"', `password = "${R}"`],
    ['_PASS env', 'RHSSO_ADMIN_PASS=Welcome2024!', `RHSSO_ADMIN_PASS=${R}`],
    ['pwsh $env PASS', '$env:KC_PASS = "Sup3r-S3cret!"', `$env:KC_PASS = "${R}"`],
    ['bypass is not a pass', 'bypass: true\ncompass=north', 'bypass: true\ncompass=north'],
    ['keycloak client secret json', '{"type":"secret","value":"7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41"}', `{"type":"secret","value":"${R}"}`],
    ['client secret prose', 'client secret for iam-portal is 7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41', `client secret for iam-portal is ${R}`],
    ['tls.key yaml', '  tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2', `  tls.key: ${R}`],
    ['curl -u', 'curl -u admin:S3cret https://x', `curl -u admin:${R} https://x`],
    ['mysql -p', 'mysql -h db -pS3cretPw keycloak', `mysql -h db -p${R} keycloak`],
    ['anthropic key', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', `key ${R}`],
    ['gitlab token', 'glpat-AbCdEfGhIjKlMnOpQrSt12', R],
    ['token_type stays', '"token_type":"Bearer"', '"token_type":"Bearer"'],
    ['bearer needs a token', 'token type: Bearer expires: 300', 'token type: Bearer expires: 300'],
    ['hashtable authorization keeps the rest', '{Authorization=Bearer abc.def.ghi, X-Forwarded-For=203.0.113.50}', `{Authorization=${R}, X-Forwarded-For=203.0.113.50}`],
    // third review of 0.30: quoted user:pass, Redis passwords, literal values that start with $ or %
    ['curl -u "user:pass"', 'curl -u "u:S3cretPW" https://x', `curl -u "u:${R}" https://x`],
    ["curl -u 'user:pass with a space'", "curl -u 'u:S3cret PW' https://x", `curl -u 'u:${R}' https://x`],
    ['curl -u "…" with an escaped quote', 'curl -u "u:S3c\\"ret" https://x', `curl -u "u:${R}" https://x`],
    ['redis-server --requirepass', 'command: redis-server --requirepass S3cretPW', `command: redis-server --requirepass ${R}`],
    ['redis.conf requirepass', 'requirepass S3cretPW', `requirepass ${R}`],
    ['redis.conf masterauth', 'bind 0.0.0.0\nmasterauth S3cretPW\n', `bind 0.0.0.0\nmasterauth ${R}\n`],
    ['CONFIG SET requirepass', 'CONFIG SET requirepass S3cretPW', `CONFIG SET requirepass ${R}`],
    // fourth review of 0.30: bare requirepass/masterauth only where a line starts or after config set
    ['redis.conf commented out', '# requirepass S3cretPW', `# requirepass ${R}`],
    ['redis.conf ; and indent', '  ; masterauth S3cretPW', `  ; masterauth ${R}`],
    ['YAML list item', '  - requirepass S3cretPW', `  - requirepass ${R}`],
    ['redis-cli config set', 'redis-cli -h h config  set masterauth S3cretPW', `redis-cli -h h config  set masterauth ${R}`],
    ['REDISCLI_AUTH=', 'REDISCLI_AUTH=S3cretPW redis-cli', `REDISCLI_AUTH=${R} redis-cli`],
    ["--password '$…' (literal)", "--password '$3cretPW'", `--password ${R}`],
    ['--password %… (no %VAR%)', '--password %3cretPW', `--password ${R}`],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(r.redact(input), expected));
  }

  it('redacts every data value of a Secret manifest (YAML), keeping key names', () => {
    const yaml = [
      'apiVersion: v1',
      'data:',
      '  ca.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t',
      '  username: YWRtaW4=',
      '  .dockerconfigjson: eyJhdXRocyI6e319',
      'kind: Secret',
      'metadata:',
      '  name: keycloak-admin',
      'type: Opaque',
    ].join('\n');
    const out = r.redact(yaml);
    assert.match(out, /  username: \[REDACTED\]\n/);
    assert.match(out, /  ca\.crt: \[REDACTED\]\n/);
    assert.match(out, /  \.dockerconfigjson: \[REDACTED\]\n/);
    assert.match(out, /  name: keycloak-admin/);
    assert.doesNotMatch(out, /YWRtaW4=/);
  });

  it('redacts Secret data in JSON, and leaves ConfigMaps alone', () => {
    const json = '{"apiVersion":"v1","data":{"password":"cGFzcw==","user":"YWRtaW4="},"kind":"Secret"}';
    assert.equal(r.redact(json), `{"apiVersion":"v1","data":{"password":"${R}","user":"${R}"},"kind":"Secret"}`);
    const cm = 'data:\n  LOG_LEVEL: debug\nkind: ConfigMap\n';
    assert.equal(r.redact(cm), cm);
  });

  it("redacts a Secret's escaped JSON in kubectl's last-applied-configuration (third review of 0.30)", () => {
    const applied =
      '"last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"data\\":{\\"db-url\\":\\"cG9zdGdyZXM6Ly91OnBAaA==\\"},\\"kind\\":\\"Secret\\"}"';
    assert.equal(r.redact(applied), `"last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"data\\":{\\"db-url\\":\\"${R}\\"},\\"kind\\":\\"Secret\\"}"`);
    const stringData = '{\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"PlainS3cretValue9\\",\\"note\\":\\"a\\\\nb\\"}}';
    assert.equal(r.redact(stringData), `{\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"${R}\\",\\"note\\":\\"${R}\\"}}`);
    // and in the whole object kubectl prints
    const full = [
      '{',
      '    "apiVersion": "v1",',
      '    "data": {',
      '        "api-url": "aHR0cHM6Ly9leGFtcGxl"',
      '    },',
      '    "kind": "Secret",',
      '    "metadata": {',
      '        "annotations": {',
      '            "kubectl.kubernetes.io/last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"PlainS3cretValue9\\"}}\\n"',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const out = r.redact(full);
    assert.doesNotMatch(out, /PlainS3cretValue9|aHR0cHM6/);
    assert.match(out, /\\"signing\\":\\"\[REDACTED\]\\"/);
    // a ConfigMap's escaped JSON stays
    const cm = '{\\"kind\\":\\"ConfigMap\\",\\"data\\":{\\"LOG_LEVEL\\":\\"debug\\"}}';
    assert.equal(r.redact(cm), cm);
  });
});

it('redacts the password after a `${…}` user part (final review of 0.30)', () => {
  assert.equal(r.redact('curl -u "${input:USER}:S3cretPw9" https://api'), `curl -u "\${input:USER}:${R}" https://api`);
  assert.equal(r.redact('curl -u "${USER}:S3cretPw9" https://api'), `curl -u "\${USER}:${R}" https://api`);
});

it('key=value redaction leaves references intact', () => {
  const r = createRedactor(DEFAULT_PATTERNS);
  assert.equal(r.redact('client_secret=${secret:KC}'), 'client_secret=${secret:KC}');
  assert.equal(r.redact('password="$(cat /run/pw)"'), 'password="$(cat /run/pw)"');
  assert.equal(r.redact('$env:TOKEN; token=$env:TOKEN'), '$env:TOKEN; token=$env:TOKEN');
  assert.equal(r.redact('set PASSWORD=%DB_PW%'), 'set PASSWORD=%DB_PW%');
  assert.equal(r.redact('password=${secret:X}tail'), 'password=[REDACTED]}tail');
  assert.equal(r.redact('password=$ecret123'), 'password=[REDACTED]');
  // in escaped JSON too: the `\` of `\"` ends a reference (second review of 0.30)
  for (const ref of ['${secret:DB_PW}', '${input:pw}', '$(cat /run/tok)', '%PW%']) {
    const s = `curl -d "{\\"password\\":\\"${ref}\\"}"`;
    assert.equal(r.redact(s), s);
  }
  assert.equal(r.redact('{\\"token\\":\\"$env:TOK\\"}'), '{\\"token\\":\\"$env:TOK\\"}');
  // a backslash before anything else is still part of the value
  assert.equal(r.redact('password=${secret:X}\\x'), 'password=[REDACTED]}\\x');
  // a flag's value: references stay, in "…" anything the shell expands, in '…' only REFERENCE (third review of 0.30)
  for (const s of [
    '--password "$PW"',
    '--password "${PW}"',
    '--password ${PW}',
    '--password $(cat f)',
    '--password %PW%',
    '--password "%PW%"',
    "--password '${secret:pw}'",
    '--password $PW',
    // the word AUTH alone is no flag
    'redis-cli AUTH default',
    'Send AUTH first, then the command.',
    // requirepass/masterauth elsewhere than at a line's start or after config set (fourth review of 0.30)
    'grep requirepass /etc/redis/redis.conf',
    'grep -n masterauth redis.conf',
    'redis-cli config get requirepass',
    // a reference after user: in quotes (fourth review of 0.30)
    'curl -u "admin:$PW" https://x',
    'curl -u "admin:${secret:pw}" https://x',
    "curl -u 'admin:${secret:pw}' https://x",
    'curl --user "admin:%PW%" https://x',
    // a whole `${…}` user part, its colon no separator (final review of 0.30)
    'curl -u "${input:USER}:${secret:API_KEY}" https://api',
    "curl -u '${input:USER}:${secret:API_KEY}' https://api",
  ]) {
    assert.equal(r.redact(s), s, s);
  }
});

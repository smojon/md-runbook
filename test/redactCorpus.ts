/**
 * Random text built from the fragments the redaction patterns look for (keys, separators, quotes,
 * values, flags, headers, tokens, references) and the ones that trip them up (padding, CRLF,
 * Unicode spaces, quotes, punctuation). Seeded, so a failure can be run again.
 */

/** mulberry32: a small seeded generator. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NBSP = String.fromCharCode(0xa0);

const KEYS = [
  'password', 'Password', 'PASSWORD', 'passwd', 'pwd', 'PWD', 'secret', 'Secret', 'client_secret', 'clientSecret', 'client-secret',
  'token', 'Token', 'access_token', 'refresh-token', 'id_token', 'token_type', 'tokens', 'api_key', 'apiKey', 'API-KEY', 'x-api-key',
  'apikey', 'accessKey', 'access_key', 'access-key', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'privateKey', 'private-key', 'privatekey',
  'client_key', 'clientkey', 'client-key', 'credentials', 'credential', 'Credentials', 'tls.key', '.key', 'ssh.key', 'db.pass', 'DB_PASS',
  'pass', 'Pass', 'PASS', 'bypass', 'compass', 'KC_PASS', '$env:KC_PASS', 'my-token', 'secrets', 'secretName', 'mysecret', 'secret2',
  '-secret', '.secret', '_token', 'a.b.password', 'pass.word', 'pwd_', 'x', 'name', 'user', 'key', 'kind', 'value', 'data', 'host',
  'passport', 'tokenizer', 'Secret-Key', '-.key', '.-key', 'a-.key', '_.key', 'secretFile', 'input', 'param',
  'REDISCLI_AUTH', 'rediscli_auth_x', 'redisCli_Auth', 'SSHPASS', 'sshpass', 'my_sshpass',
  // spaced key names (secret-key-value-spaced)
  'api key', 'API Key', 'secret  key', 'Secret\tKey', 'access key', 'private key', 'client key', 'app key', 'master key', 'account key',
  'encryption key', 'signing key', 'pass phrase', 'passphrase', 'Passphrase', 'xapi key', 'api keys', 'api monkey', 'my api key', 'api' + NBSP + 'key',
];
const HEADERS = ['Authorization', 'authorization', 'AUTHORIZATION', 'Proxy-Authorization', 'X-Authorization', 'xAuthorization', 'Cookie', 'cookie', 'Set-Cookie', 'set-cookie', 'XCookie', 'Cookies'];
const VALUES = [
  'hunter2', 'S3cr3t!', 'Adm1n-Kc-Pw', 'a b c', 'x', 'Welcome2024!', 'c2VjcmV0', 'YWRtaW4=', 'abc123', 'abc;def', 'a,b', 'x}y', 'a&b', 'a"b', "a'b",
  '${secret:X}', '${secret:X}tail', '${secretFile:K}', '${input:Y}', '${param:Z}', '${VAR}', '${VAR}x', '${VAR:-d}', '${ VAR}', '${}', '${a',
  '$(cat /run/pw)', '$(cat f)x', '$(a', '$env:TOKEN', '$ENV:Token', '$env:', '$env:T-x', '%DB_PW%', '%X%y', '%_a%', '%1%', '%a', '$x', '$ecret123',
  '${a:-b}', '${A:=x', '${A?}', '${x+y}', '${x:y}', '$((a))', '$(a(b)c)', '$(a(b', '$(a(b)', '${out:x:y}', '${secretFile:K-}', '${input:}', '$_x', '%a%%b%',
  '${Secret:X}', '$(\r)', '${a:-$(b)}', '${a:-x\ny}',
  'Bearer', 'bearer', 'Bearer abc.def-123', 'Bearer sk_live_123/abc==', 'Bearer expires', 'Bearer abcdefgh', 'Bearer abcdefg1', 'Bearer x', 'Basic dXNlcjpwYXNz',
  'Basic', 'Negotiate YII=', 'true', 'false', 'null', 'None', 'none', 'none1', 'nullable', 'Truely', 'basically',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'eyJabcde.fghij', 'eyJabcd.efghi', 'eyJabcde.fghi', 'eyJ-eyJabcde.fghijk.', 'xeyJabcde.fghij', 'eyJabcdefgh',
  'sha256~abcdefghijklmnopqrstuvwxyz0123', '-dash', '--x', '-', '$', '%', '"', "'", '""', "''", '"$x"', "'%x'", '"a b"', "'a b'", '"unterminated',
  'bob%pw2', 'bob,pw3', 'u:pw4', 'pass:pw5', 'env:VAR', 'pw%', '%pw', ',pw',
  // quoted credentials, literal `$` or `%` (third review of 0.30)
  '"u:pw6"', "'u:pw 7'", '"u%pw8"', "'u,pw9'", '"pass:pw10"', "'pass:pw 11'", '"u:a\\"b"', '" u:x"', '"u: x"', "'$3cret'", '%3cret', '"%PW%"', "'%PW%'", '"$PW"', "'$PW'",
  // references after user: in quotes (fourth review of 0.30)
  '"u:$PW"', "'u:$PW'", '"u:${secret:pw}"', "'u%${secret:pw}'", '"pass:%PW%"', '"u:$(cat f)"', '"u:${a}x"',
  // a `\"` that closes its quote, a `${…}` user part (final review of 0.30)
  '"C:\\x\\";', '"a\\" b"', "'p\\' x'", '"a\\"|', '"${input:U}:${secret:K}"', "'${U}:pw'", '"${a:b}:pw"', '"${a}x:pw"',
  '7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41', 'admin:S3cret', 'user:p%40ss', ':', 'a:b:c', '=', '==', 'abc==', 'abcdefgh==', 'abc/def+ghi~jkl_', 'ABCDEFGHIJ',
  // backslashes: escaped quotes, escaped JSON, Windows paths
  'abc\\"def', 'a\\\\b', '\\', 'x\\', '\\"', "\\'", 'C:\\', '\\"hunter2\\"', '"a\\"b"', '"C:\\"', "'it\\'s'", '"a\\\r"', '\\"a\\\\\\"b\\"',
  // escaped twice: runs of 2 to 7 backslashes before a quote
  's3c\\\\\\"ret', 'a\\\\\\\\\\"', 'a\\\\"b', 'a\\\\\\\\"b', 'a\\\\\\\\\\\\\\"b', "a\\\\\\'b", '\\\\\\\\\\\\x',
  // text glued to a closing quote: words, segments, `'\''`, and what ends one
  '"a"b', "'a'b", `'a'"b"c`, "'it'\\''s'", '"a""b"', `"a"'b c'`, "'a'.b", "'a'$X", '\\"a\\"b', '\\"a\\"-b', `'a'"b`, "\"a\"\\'b", "'a'b,c", "'a'b)c", "'a'`b`", "'a''b c'", '"a""b c"', `'a'b"c d"`,
];
const FLAGS = [
  '--password', '-password', '--PASSWORD', '--pass', '-pass', '--passwd', '--client-secret', '--token', '-token', '--api-key', '--apikey',
  '--access-key', '--secret-key', '--secret', 'x--password', '---password', '--passwords', '-p', '-P', '-pS3cretPw', '-u', '-U', '--user', '--USER',
  '--u', '-user', 'login', 'oc login', 'LOGIN', 'relogin', 'login2', 'mysql', 'MYSQL', 'mysql -h db', 'mysqldump', 'kcadm.sh config credentials', 'curl',
  // tools that take a password (password-flag-tool), and look-alikes
  'sshpass', 'sshpass -p', 'redis-cli', 'redis-cli -a', 'ldapsearch', 'ldapsearch -x -w', '-w', '-a', '-A', '-X', 'smbclient', 'smbclient //h/s -U',
  'rpcclient -U', 'lftp -u', 'openssl rsa -passin', 'openssl enc -k', '-passin', '-passout', 'pass:', 'htpasswd -b f', 'htpasswd -nb', 'htpasswd -bc',
  'htpasswd -c -b', 'htpasswd', 'mysqldump -u root', 'mariadb-dump', '7z a', '7za', 'zip', 'unzip -P', 'curl -U', '--proxy-user', 'cmdkey /pass:',
  'cmdkey', '/pass:', 'xfreerdp /p:', '/p:', 'nmcli', 'password', 'wifi-sec.psk', 'keytool', '-storepass', '-new', 'snmpwalk', 'sqlcmd', 'bcp',
  'mongosh', 'mongo', 'mosquitto_pub', 'ipmitool', 'PsExec', 'psexec', 'schtasks', '/RP', '/rp', 'ssh', 'psql', 'xsshpass', 'sshpass2',
  // where a command starts, and where it ends (password-flag-tool)
  '|', '||', ';', '&&', '&', '`', '(', '$(', '| sshpass -p', '; redis-cli -a', '&& ldapsearch -w', 'sudo', 'sudo sshpass -p', 'exec', '--', 'env',
  'time', 'env A=b', 'A=b', 'sudo -E', 'docker exec -it c', 'docker exec c', 'docker compose exec svc', 'kubectl exec p --', 'xexec', '"exec"',
  '/usr/bin/sshpass', './sshpass', 'C:\\T\\PsExec.exe', 'PsExec64.exe', 'sshpass.exe', 'sshpass.exex', 'PSEXEC', 'SCHTASKS', 'SchTasks /Create /RP',
  'CMDKEY', 'CMDKEY /PASS:', 'Cmdkey /Pass:', '/Rp', '/PASS:', 'mongo-1', 'mongo:7', 'app.zip', 'a.zip -P', '@zip', 'x/zip', '"a|b"', "'a;b'", '"x',
  // prefixes, paths, wrappers, Redis (third review of 0.30)
  '@sshpass -p', '\t-sshpass -p', '@-mongo', 'ExecStart=sshpass -p', 'exec:redis-cli -a', '--name=mongo -p', '-e HOST=mongo -p', 'ExecStart=/usr/bin/redis-cli',
  '~/.ssh/mongo -p', 'ls /opt/mongo -p', 'ssh -i ~/.ssh/zip -P', 'sudo /usr/bin/sshpass', 'X=1 /usr/bin/sshpass', 'X="a b" /zip', '$(/usr/bin/mongo',
  'sudo -E sshpass -p', 'env -i redis-cli -a', 'xsudo -E mongo -p', 'timeout --foreground', 'mysql -uroot -p', 'requirepass', 'masterauth', '--requirepass',
  'CONFIG SET requirepass', 'xrequirepass', '-u "', "-U '", '-passin "pass:', 'smbclient -U"',
  'docker run -d --name mongo -p', 'ssh mongo-1 -p', 'grep -w', 'curl -k',
  // command segments (second review of 0.30): quotes, prompts, an option before a tool, continued lines
  '-c "', "-c '", 'sh -c "redis-cli -a', 'cmd /c "sqlcmd -P', '-h', '--name', '-it', '-oL', '-n 10', 'nohup', 'xargs', 'PS C:\\>', '{', '!',
  'then', '"sshpass', "'mongo", '"C:\\P F\\7z.exe"', '7z.exe', '\\7z', '{zip', '(zip', '`zip', 'mongo"', "zip'", '\\\n', ' \\\r\n', '"a\\"b"',
  'x"y', '\\\\', '-x=a', '--a-b', '-1', '"\\\\"', '-h\nmongo',
  // bin/ and .exe paths, wrapper options and their values, prefixes after NAME=, Redis (fourth review of 0.30)
  '/usr/local/bin/redis-cli -a', 'kubectl exec p -- /usr/bin/mysql', 'RUN /opt/x/bin/sqlcmd', '/sbin/zip', 'C:\\bin\\7z', 'bin/mongo', 'mybin/zip',
  'C:\\T\\7z.exe a', 'cmd /c', '/zip.EXE', 'strace -f', 'ssh -i /usr/bin/mongo', 'sudo -u', 'sudo -u root', 'sudo -u mongo', 'sudo -E -H', 'sudo -n -E',
  'sudo -uroot', 'sudo -u root -E', 'env -u', 'env -u x -i', 'nice -n', 'timeout -s KILL', 'timeout -k', 'stdbuf -o', 'stdbuf -oL', 'doas -u', '-u mongo',
  'ExecStart=-sshpass -p', 'ExecStart=@sshpass', 'X=-', 'X=@-zip', 'grep requirepass', '# requirepass', '#;requirepass', '; masterauth', '- requirepass',
  '-requirepass', 'config set', 'config  set masterauth', 'CONFIG get requirepass', 'xconfig set requirepass', 'set requirepass', '\n  - masterauth',
  // htpasswd's options in several words, sshpass's own options (final review of 0.30)
  'htpasswd -b -c f', 'htpasswd -c -b', 'htpasswd -B -b f u', 'htpasswd -n -b', 'htpasswd -bC 5 f', 'htpasswd -C', '-C 5', 'htpasswd -b "a b"',
  'sshpass -e ssh', 'sshpass -f f', 'sshpass -P "x"', 'sshpass -d', '-f', '-e', '"sshpass"',
];
const OTHER = [
  'eyJ', 'eyJhbGciOi', 'Bearer', 'bearer', 'BEARER', 'xBearer', '.', '-', '_', 'x', 'abc', 'a1', '://', 'https://user:pw@host/x', 'git://a:b@c',
  'https://x.y/z', 'a://b:c', 'x+y.z-1://u:p@', '_x://u:p@', '1a://u:p@', 'a://b:c:d@e', 'a:/b:c@', '{', '}', '[', ']', '(', ')', '@', '/', '~', '+',
  ',', ';', '&', '"type":"secret","value":"x"', '{"type" : "secret",\t"value":  "abc"}', '"TYPE":"Secret","Value":"', '"type":"secret", "value": "', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', 'secret for app is',
  'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '0', '1234', 'k=v', 'a=b', 'k: v', '#', '- ', '?sig=', 'AccountKey=',
];
const BLANKS = ['', ' ', ' ', ' ', '  ', '\t', ' \t', '   ', '\u00a0', '\u3000', '\u2028', '\ufeff', '\u2003'];
const SEPS = [':', '=', ': ', ' = ', ':\t', ' :  ', '  =', '":"', '": "', "'='", '"=', "':", ' : ', '=\t\t', '::', '==', ':=', '= :'];
const QUOTES = ['', '', '', '"', "'", '"', '\\"'];

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

/** A run of blanks, now and then a long one. */
function pad(r: () => number): string {
  const x = r();
  if (x < 0.6) return pick(r, BLANKS);
  if (x < 0.9) return ' '.repeat(1 + Math.floor(r() * 8));
  if (x < 0.97) return (r() < 0.5 ? ' ' : '\t').repeat(10 + Math.floor(r() * 90));
  return ' \t'.repeat(50 + Math.floor(r() * 500));
}

function keyValueLine(r: () => number): string {
  const q1 = pick(r, QUOTES);
  const q2 = pick(r, QUOTES);
  const key = r() < 0.15 ? pick(r, HEADERS) : pick(r, KEYS);
  const sep = r() < 0.7 ? pick(r, SEPS) : pad(r) + pick(r, [':', '=']) + pad(r);
  const value = pick(r, VALUES);
  const pre = r() < 0.5 ? '' : pick(r, ['export ', '  ', '- ', '{', '"', "'", 'x', '$', '.', '-', '[', 'set ', '?', '&', '\t', ' ']);
  const post = r() < 0.5 ? '' : pick(r, [',', ';', '}', '"', "'", ' ', '&x=1', ' # c', pad(r) + 'x', '\r', 'x', '$y', '"b"', "'b'c", "\\'", ')', ']']);
  return `${pre}${q1}${key}${q1}${sep}${q2}${value}${q2}${post}`;
}

function flagLine(r: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) parts.push(pick(r, FLAGS), pick(r, ['', ' ', '\t', '  ', pad(r), '=']), pick(r, VALUES));
  return parts.join(pick(r, [' ', ' ', '\t', '', pad(r)]));
}

function soupLine(r: () => number): string {
  const lists = [KEYS, HEADERS, VALUES, FLAGS, OTHER, SEPS, QUOTES, BLANKS];
  const n = 1 + Math.floor(r() * 10);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(r, lists.map((l) => () => pick(r, l)).concat([() => pad(r)]))();
  return s;
}

/** One random line. */
export function corpusLine(r: () => number): string {
  const x = r();
  if (x < 0.45) return keyValueLine(r);
  if (x < 0.7) return flagLine(r);
  return soupLine(r);
}

/** `lines` random lines in texts of up to 40 lines each, joined by LF or CRLF (and now and then a lone CR). */
export function* corpus(seed: number, lines: number): Generator<string> {
  const r = random(seed);
  for (let made = 0; made < lines; ) {
    const n = Math.min(lines - made, 1 + Math.floor(r() * 40));
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(corpusLine(r));
    made += n;
    yield out.join(pick(r, ['\n', '\n', '\r\n', '\r']));
  }
}

const YAML_KEYS = ['kind', 'data', 'stringData', 'metadata', 'name', 'type', 'apiVersion', 'items', 'tls.crt', 'password', 'a', '"kind"', "'data'", 'Kind'];
const YAML_VALUES = ['', '', '', 'Secret', 'Secret', '"Secret"', "'Secret'", 'ConfigMap', 'Opaque', 'v1', 'YWRtaW4=', '|', '>-', '|+2', 'x # c', '{}', '[REDACTED]', 'Secret # c', ' Secret'];

/** One line of a random YAML document: a key at some depth, a list item, a break, a comment or a block line. */
function yamlLine(r: () => number, depth: number): string {
  const x = r();
  if (x < 0.04) return pick(r, ['---', '...', '--- ', '']);
  if (x < 0.08) return pick(r, ['# c', '  # c', '', '   ', '\t']);
  const indent = '  '.repeat(depth) + (r() < 0.15 ? pick(r, ['- ', '- - ', '-  ']) : '') + (r() < 0.05 ? ' ' : '');
  if (x < 0.15) return indent + pick(r, ['LS0tLS1CRUdJTi', 'line of a block', 'x: y: z', '-', 'a:b']);
  const key = pick(r, YAML_KEYS);
  const value = pick(r, YAML_VALUES);
  return `${indent}${key}${pick(r, [':', ':', ' :', ':  '])}${value === '' ? '' : ' ' + value}${r() < 0.05 ? '  ' : ''}`;
}

/** One random JSON-like text: objects nested, `"data": {…}` and `"kind": "Secret"` in them, escaped now and then, braces missing or extra. */
function jsonText(r: () => number, size: number): string {
  let s = '';
  let depth = 0;
  for (let i = 0; i < size; i++) {
    const x = r();
    const q = r() < 0.15 ? '\\"' : '"';
    if (x < 0.2) {
      s += '{';
      depth++;
    } else if (x < 0.35 && (depth > 0 || r() < 0.2)) {
      s += '}';
      depth--;
    } else if (x < 0.5) s += `${q}data${q}${pick(r, [':', ' : ', ':\n'])}{${q}k${q}:${q}djE=${q}${pick(r, ['', `,${q}k2${q}: ${q}v${q}`])}}`;
    else if (x < 0.55) s += `${q}stringData${q}:{}`;
    else if (x < 0.65) s += `${q}kind${q}${pick(r, [':', ' : '])}${q}${pick(r, ['Secret', 'Secret', 'ConfigMap', 'Secrets'])}${q}`;
    else if (x < 0.7) s += `"s{t}r"`;
    else s += pick(r, [',', ', ', '\n', ' ', '"a":1', '"x":"y"', '[', ']', '"data":', '"data":{', '\\"kind\\":']);
  }
  return s;
}

const KUBE_WORDS = [
  'kubectl', 'oc', 'helm', 'kubens', 'kustomize', 'istioctl', 'flux', 'argocd', 'velero', 'find', 'xkubectl', 'kubectl2', 'get pods', 'logs',
  '-n', '-n', '-N', '-n=', '-nprod', '-nfoo-bar', '--namespace', '--namespace=', '--namespace ', '-name', '-newer', '-not', '--namespaces', '-n-',
  'prod', 'my-ns', 'kube-system', 'default', 'a', 'A-b', 'x_y', 'a.b', 'ns-', '1', '-x', 'foo--bar', '"prod"', "'prod'", '$NS', 'prod.', 'prod_',
  'namespace:', 'namespace: ', '"namespace": "', '"namespace" :"', 'namespace/', 'namespaces "', 'Namespace "', 'project "', 'projects  "',
  'oc project ', 'oc new-project ', 'oc  project\t', 'oc new-new-project ', 'xoc project ', 'kubens ', 'ns=', 'NS =', 'my_ns=', '$ns=', 'app_namespace = "',
  'namespace=', '_ns=', 'ns =\t', 'namespace /', 'https://host.example.com/x', 'http://user:pw@db.internal:5432', 'git+ssh://git@github.com/org',
  'ftp://a', 's3://bucket.name/key', 'a.b.c://x', '-://x', 'x://@host', 'x://user@/path', 'HTTPS://Host.Corp', 'xn--://', '1http://', '_a://b',
  'a.a.a.a', 'https://a.', 'https://-a-.b', 'http://u@@h', 'http://u:p@h.example', 'web+x://h', 'http:/x', '://', 'a://b.c.d.', 'http://[::1]/',
];

/** Lines of `kubectl … -n NAME`, namespaces in YAML, JSON and shell, and URLs, with padding, quotes and line breaks of all kinds. */
export function* kubeCorpus(seed: number, lines: number): Generator<string> {
  const r = random(seed);
  for (let made = 0; made < lines; ) {
    const n = Math.min(lines - made, 1 + Math.floor(r() * 30));
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let line = r() < 0.2 ? pick(r, ['  ', '- ', '\t', '$ ', '> ']) : '';
      const k = 1 + Math.floor(r() * 9);
      for (let j = 0; j < k; j++) line += pick(r, KUBE_WORDS) + pick(r, ['', ' ', ' ', ' ', '  ', '\t', '=', '"', "'", pad(r), ',', '/', ':']);
      out.push(line);
    }
    made += n;
    yield out.join(pick(r, ['\n', '\n', '\r\n', '\r', '\u2028']));
  }
}

/** Random Kubernetes-like documents: YAML (`count` lines in texts of up to 60) and JSON texts, also malformed. */
export function* k8sCorpus(seed: number, count: number): Generator<string> {
  const r = random(seed);
  for (let made = 0; made < count; ) {
    if (r() < 0.6) {
      const n = 1 + Math.floor(r() * 60);
      const lines: string[] = [];
      let depth = 0;
      for (let i = 0; i < n; i++) {
        depth = Math.max(0, Math.min(6, depth + pick(r, [-2, -1, 0, 0, 1, 1])));
        lines.push(yamlLine(r, depth));
      }
      made += n;
      yield lines.join(pick(r, ['\n', '\n', '\r\n']));
    } else {
      const n = 1 + Math.floor(r() * 80);
      made += n;
      yield jsonText(r, n);
    }
  }
}

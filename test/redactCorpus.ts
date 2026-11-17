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

const KEYS = [
  'password', 'Password', 'PASSWORD', 'passwd', 'pwd', 'PWD', 'secret', 'Secret', 'client_secret', 'clientSecret', 'client-secret',
  'token', 'Token', 'access_token', 'refresh-token', 'id_token', 'token_type', 'tokens', 'api_key', 'apiKey', 'API-KEY', 'x-api-key',
  'apikey', 'accessKey', 'access_key', 'access-key', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'privateKey', 'private-key', 'privatekey',
  'client_key', 'clientkey', 'client-key', 'credentials', 'credential', 'Credentials', 'tls.key', '.key', 'ssh.key', 'db.pass', 'DB_PASS',
  'pass', 'Pass', 'PASS', 'bypass', 'compass', 'KC_PASS', '$env:KC_PASS', 'my-token', 'secrets', 'secretName', 'mysecret', 'secret2',
  '-secret', '.secret', '_token', 'a.b.password', 'pass.word', 'pwd_', 'x', 'name', 'user', 'key', 'kind', 'value', 'data', 'host',
  'passport', 'tokenizer', 'Secret-Key', '-.key', '.-key', 'a-.key', '_.key', 'secretFile', 'input', 'param',
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
  '7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41', 'admin:S3cret', 'user:p%40ss', ':', 'a:b:c', '=', '==', 'abc==', 'abcdefgh==', 'abc/def+ghi~jkl_', 'ABCDEFGHIJ',
];
const FLAGS = [
  '--password', '-password', '--PASSWORD', '--pass', '-pass', '--passwd', '--client-secret', '--token', '-token', '--api-key', '--apikey',
  '--access-key', '--secret-key', '--secret', 'x--password', '---password', '--passwords', '-p', '-P', '-pS3cretPw', '-u', '-U', '--user', '--USER',
  '--u', '-user', 'login', 'oc login', 'LOGIN', 'relogin', 'login2', 'mysql', 'MYSQL', 'mysql -h db', 'mysqldump', 'kcadm.sh config credentials', 'curl',
];
const OTHER = [
  'eyJ', 'eyJhbGciOi', 'Bearer', 'bearer', 'BEARER', 'xBearer', '.', '-', '_', 'x', 'abc', 'a1', '://', 'https://user:pw@host/x', 'git://a:b@c',
  'https://x.y/z', 'a://b:c', 'x+y.z-1://u:p@', '_x://u:p@', '1a://u:p@', 'a://b:c:d@e', 'a:/b:c@', '{', '}', '[', ']', '(', ')', '@', '/', '~', '+',
  ',', ';', '&', '"type":"secret","value":"x"', '{"type" : "secret",\t"value":  "abc"}', '"TYPE":"Secret","Value":"', '"type":"secret", "value": "', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', 'secret for app is',
  'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '0', '1234', 'k=v', 'a=b', 'k: v', '#', '- ', '?sig=', 'AccountKey=',
];
const BLANKS = ['', ' ', ' ', ' ', '  ', '\t', ' \t', '   ', '\u00a0', '\u3000', '\u2028', '\ufeff', '\u2003'];
const SEPS = [':', '=', ': ', ' = ', ':\t', ' :  ', '  =', '":"', '": "', "'='", '"=', "':", ' : ', '=\t\t', '::', '==', ':=', '= :'];
const QUOTES = ['', '', '', '"', "'"];

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
  const post = r() < 0.5 ? '' : pick(r, [',', ';', '}', '"', "'", ' ', '&x=1', ' # c', pad(r) + 'x', '\r']);
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

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
import { DEFAULT_PATTERNS, WIDENED_PATTERN_NAMES, createRedactor, mergeSpans, patternFinder, redactSecretManifests } from '@md-runbook/core/redact';
import { corpus, k8sCorpus, kubeCorpus } from './redactCorpus';

const LINES = Number(process.env.WIDEN_CORPUS_LINES ?? 30_000);
const ROOT = path.join(__dirname, '..', '..');
const R = '[REDACTED]';
const NBSP = String.fromCharCode(0xa0);
const IDEO = String.fromCharCode(0x3000);

const redactor = createRedactor(DEFAULT_PATTERNS);
const before = createRedactor(DEFAULT_PATTERNS.filter((p) => !WIDENED_PATTERN_NAMES.has(p.name ?? '')));
const beforeFinders = DEFAULT_PATTERNS.filter((p) => !WIDENED_PATTERN_NAMES.has(p.name ?? '')).map((p) => patternFinder(p));

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
    // a tool as a word of its own anywhere in its segment (second review of 0.30): in quotes, after
    // any command or word but an option's value, after a prompt, and in a continued line
    ['ssh "…"', 'ssh h "sshpass -p Xs3cret1 ssh o"', `ssh h "sshpass -p ${R} ssh o"`],
    ["bash -c '…'", "bash -c 'sshpass -p Xs3cret1 x'", `bash -c 'sshpass -p ${R} x'`],
    ['kubectl exec … sh -c "…"', 'kubectl exec pod -- sh -c "redis-cli -a Xs3cret1 ping"', `kubectl exec pod -- sh -c "redis-cli -a ${R} ping"`],
    ['cmd /c "…"', 'cmd /c "sqlcmd -S s -P Xs3cret1"', `cmd /c "sqlcmd -S s -P ${R}"`],
    ['nohup', 'nohup sshpass -p Xs3cret1 ssh h', `nohup sshpass -p ${R} ssh h`],
    ['timeout', 'timeout 5 mysql -pXs3cret1', `timeout 5 mysql -p${R}`],
    ['xargs', 'xargs mysql -pXs3cret1', `xargs mysql -p${R}`],
    ['watch', 'watch redis-cli -a Xs3cret1', `watch redis-cli -a ${R}`],
    ['nice -n 10', 'nice -n 10 mysql -pXs3cret1', `nice -n 10 mysql -p${R}`],
    ['nice -n 10 mysqldump', 'nice -n 10 mysqldump -pXs3cret1 db', `nice -n 10 mysqldump -p${R} db`],
    ['stdbuf -oL', 'stdbuf -oL redis-cli -a Xs3cret1', `stdbuf -oL redis-cli -a ${R}`],
    ['sudo -u root', 'sudo -u root sshpass -p Xs3cret1 ssh h', `sudo -u root sshpass -p ${R} ssh h`],
    ['docker exec -u root', 'docker exec -it -u root db redis-cli -a Xs3cret1', `docker exec -it -u root db redis-cli -a ${R}`],
    ['docker exec -e', 'docker exec -e FOO=bar db mysql -pXs3cret1', `docker exec -e FOO=bar db mysql -p${R}`],
    ['docker run -it IMAGE TOOL', 'docker run -it mongo mongosh -p Xs3cret1', `docker run -it mongo mongosh -p ${R}`],
    ['for … do', 'for h in a b; do sshpass -p Xs3cret1 ssh $h; done', `for h in a b; do sshpass -p ${R} ssh $h; done`],
    ['then', 'then redis-cli -a Xs3cret1', `then redis-cli -a ${R}`],
    // (secret-flag-value's mysql -p reads to the next blank, `;` too, as in 0.29.0)
    ['{ …; }', '{ mysql -pXs3cret1; }', `{ mysql -p${R} }`],
    ['! …', '! mysql -pXs3cret1', `! mysql -p${R}`],
    ['$ prompt', '$ redis-cli -a Xs3cret1', `$ redis-cli -a ${R}`],
    ['# prompt', '# mysql -pXs3cret1', `# mysql -p${R}`],
    ['PS prompt', 'PS C:\\> sqlcmd -S s -P Xs3cret1', `PS C:\\> sqlcmd -S s -P ${R}`],
    ['root prompt', 'root@h:~# mysql -pXs3cret1', `root@h:~# mysql -p${R}`],
    ['Dockerfile RUN', 'RUN mysqldump -pXs3cret1 db', `RUN mysqldump -p${R} db`],
    ['& "C:\\…\\7z.exe"', '& "C:\\Program Files\\7-Zip\\7z.exe" x a.7z -pXs3cret1', `& "C:\\Program Files\\7-Zip\\7z.exe" x a.7z -p${R}`],
    ['an escaped quote before the flag', 'redis-cli -h "a\\"b" -a Xs3cret1', `redis-cli -h "a\\"b" -a ${R}`],
    ['an open quote before the flag', 'redis-cli -h x"y -a Xs3cret1', `redis-cli -h x"y -a ${R}`],
    ['a | in quotes before the flag', 'redis-cli --eval "a|b" -a Xs3cret1', `redis-cli --eval "a|b" -a ${R}`],
    ['a continued line', 'redis-cli -h host \\\n  -a Xs3cret1 ping', `redis-cli -h host \\\n  -a ${R} ping`],
    ['a continued line (CRLF)', 'redis-cli -h host \\\r\n  -a Xs3cret1 ping', `redis-cli -h host \\\r\n  -a ${R} ping`],
    ['a continued line after the tool', 'sshpass \\\n -p Xs3cret1 ssh h', `sshpass \\\n -p ${R} ssh h`],
    ['a flag right after a continued line', 'sshpass \\\n-p Xs3cret1 ssh h', `sshpass \\\n-p ${R} ssh h`],
    ['continued twice', 'redis-cli \\\r\n  -h h \\\r\n  -a Xs3cret1', `redis-cli \\\r\n  -h h \\\r\n  -a ${R}`],
    // third review of 0.30: quoted user<sep>pass, mysql -p'…', a wrapper's option, prefixes, literal $ and %
    ['smbclient -U "user%pass"', 'smbclient //h/s -U "u%S3cretPW"', `smbclient //h/s -U "u%${R}"`],
    ['smbclient -U "DOM\\\\user%pass"', 'smbclient -U "DOM\\\\u%S3cretPW"', `smbclient -U "DOM\\\\u%${R}"`],
    ['smbclient -U"user%pass" (glued)', 'smbclient -U"u%S3cretPW"', `smbclient -U"u%${R}"`],
    ["lftp -u 'user,pass'", "lftp -u 'u,S3cretPW' h", `lftp -u 'u,${R}' h`],
    ['curl -U "user:pass" (proxy)', 'curl -x p:3128 -U "u:S3cretPW" https://x', `curl -x p:3128 -U "u:${R}" https://x`],
    ["openssl -passin 'pass:…'", "openssl pkcs12 -in a.p12 -passin 'pass:S3cret PW'", `openssl pkcs12 -in a.p12 -passin 'pass:${R}'`],
    ["mysql -p'…'", "mysql -uroot -p'P@ss!w0rd' -e 'select 1'", `mysql -uroot -p${R} -e 'select 1'`],
    ['mysql -p"…"', 'mysql -u root -p"S3cretPW" db', `mysql -u root -p${R} db`],
    ['sudo -E sshpass', 'sudo -E sshpass -p S3cretPW ssh h', `sudo -E sshpass -p ${R} ssh h`],
    ['sudo -i mongosh', 'sudo -i mongosh -u a -p S3cretPW', `sudo -i mongosh -u a -p ${R}`],
    ['env -i redis-cli', 'env -i redis-cli -a S3cretPW', `env -i redis-cli -a ${R}`],
    ['Makefile @', '\t@sshpass -p S3cretPW scp a b', `\t@sshpass -p ${R} scp a b`],
    ['Makefile -', '\t-sshpass -p S3cretPW scp a b', `\t-sshpass -p ${R} scp a b`],
    ['Makefile @-', '\t@-sshpass -p S3cretPW scp a b', `\t@-sshpass -p ${R} scp a b`],
    ['ExecStart=', 'ExecStart=sshpass -p S3cretPW ssh h', `ExecStart=sshpass -p ${R} ssh h`],
    ['exec:', 'exec:sshpass -p S3cretPW', `exec:sshpass -p ${R}`],
    ["sshpass -p '$…' (literal)", "sshpass -p '$3cretPW' ssh h", `sshpass -p ${R} ssh h`],
    ['sshpass -p %… (no %VAR%)', 'sshpass -p %3cretPW ssh h', `sshpass -p ${R} ssh h`],
    ['a path at the start', '/usr/bin/sshpass -p S3cretPW ssh h', `/usr/bin/sshpass -p ${R} ssh h`],
    ['a path after sudo', 'sudo /usr/bin/sshpass -p S3cretPW ssh h', `sudo /usr/bin/sshpass -p ${R} ssh h`],
    ['a path after VAR=value', 'X=1 /usr/bin/sshpass -p S3cretPW ssh h', `X=1 /usr/bin/sshpass -p ${R} ssh h`],
    ['a path after ExecStart=', 'ExecStart=/usr/bin/redis-cli -a S3cretPW', `ExecStart=/usr/bin/redis-cli -a ${R}`],
    ['a path after &&', 'cd /x && ./sshpass -p S3cretPW ssh h', `cd /x && ./sshpass -p ${R} ssh h`],
    ['a path in $(…)', 'X=$(/usr/bin/redis-cli -a S3cretPW get k)', `X=$(/usr/bin/redis-cli -a ${R} get k)`],
    ['a path in quotes', 'sh -c "cd /x && /usr/bin/sshpass -p S3cretPW ssh h"', `sh -c "cd /x && /usr/bin/sshpass -p ${R} ssh h"`],
    // fourth review of 0.30: a path in a bin/ directory or to NAME.exe, no option's value, counts anywhere
    ['RUN …/bin/sqlcmd', 'RUN /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P S3cretPW', `RUN /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P ${R}`],
    ['kubectl exec -- …/bin/redis-cli', 'kubectl exec pod -- /usr/local/bin/redis-cli -a S3cretPW info', `kubectl exec pod -- /usr/local/bin/redis-cli -a ${R} info`],
    ['docker exec …/bin/mysqldump', 'docker exec c /usr/bin/mysqldump -pS3cretPW db', `docker exec c /usr/bin/mysqldump -p${R} db`],
    ['docker compose exec', 'docker compose exec redis /usr/local/bin/redis-cli -a S3cretPW ping', `docker compose exec redis /usr/local/bin/redis-cli -a ${R} ping`],
    ['sudo -u root …/bin/sshpass', 'sudo -u root /usr/bin/sshpass -p S3cretPW ssh h', `sudo -u root /usr/bin/sshpass -p ${R} ssh h`],
    ['sudo -- …/bin/sshpass', 'sudo -- /usr/bin/sshpass -p S3cretPW ssh h', `sudo -- /usr/bin/sshpass -p ${R} ssh h`],
    ['nice -n 10 …/bin/mysql', 'nice -n 10 /usr/bin/mysql -pS3cretPW', `nice -n 10 /usr/bin/mysql -p${R}`],
    ['watch -n 5 …/bin/redis-cli', 'watch -n 5 /usr/bin/redis-cli -a S3cretPW', `watch -n 5 /usr/bin/redis-cli -a ${R}`],
    ['$ prompt', '$ /usr/bin/sshpass -p S3cretPW ssh h', `$ /usr/bin/sshpass -p ${R} ssh h`],
    ['# prompt', '# /usr/sbin/sshpass -p S3cretPW ssh h', `# /usr/sbin/sshpass -p ${R} ssh h`],
    ['YAML command:', 'command: /usr/bin/sshpass -p S3cretPW', `command: /usr/bin/sshpass -p ${R}`],
    ['cmd /c …\\7z.exe', 'cmd /c C:\\Tools\\7z.exe a -pS3cretPW x.7z', `cmd /c C:\\Tools\\7z.exe a -p${R} x.7z`],
    ['PS> …\\7z.exe', 'PS> C:\\Tools\\7z.exe a -pS3cretPW x.7z', `PS> C:\\Tools\\7z.exe a -p${R} x.7z`],
    ['a path after a wrapper option', 'sudo -E /opt/x/sshpass -p S3cretPW ssh h', `sudo -E /opt/x/sshpass -p ${R} ssh h`],
    ['a path after a wrapper option and its value', 'timeout -s KILL /opt/x/sshpass -p S3cretPW', `timeout -s KILL /opt/x/sshpass -p ${R}`],
    // wrapper options in a row, a wrapper option's value, prefixes after NAME=
    ['sudo -E -H', 'sudo -E -H sshpass -p S3cretPW ssh h', `sudo -E -H sshpass -p ${R} ssh h`],
    ['sudo -n -E', 'sudo -n -E sshpass -p S3cretPW ssh h', `sudo -n -E sshpass -p ${R} ssh h`],
    ['sudo -u root -E', 'sudo -u root -E sshpass -p S3cretPW ssh h', `sudo -u root -E sshpass -p ${R} ssh h`],
    ['stdbuf -oL', 'stdbuf -oL redis-cli -a S3cretPW', `stdbuf -oL redis-cli -a ${R}`],
    ['ExecStart=-', 'ExecStart=-sshpass -p S3cretPW', `ExecStart=-sshpass -p ${R}`],
    ['ExecStart=@', 'ExecStart=@sshpass -p S3cretPW', `ExecStart=@sshpass -p ${R}`],
    // accepted: a tool's name in an echoed string counts too
    ['echo "mongosh -p …" (accepted)', 'echo "mongosh -p 27017"', `echo "mongosh -p ${R}"`],
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
    // htpasswd: quoted passwords, options in several words, -C and its value (final review of 0.30)
    ["htpasswd -b '…'", "htpasswd -b /etc/nginx/.htpasswd admin 'S3cretPw9'", `htpasswd -b /etc/nginx/.htpasswd admin ${R}`],
    ['htpasswd -b "…"', 'htpasswd -b /etc/nginx/.htpasswd admin "S3cret Pw9"', `htpasswd -b /etc/nginx/.htpasswd admin ${R}`],
    ["htpasswd -nb '…'", "htpasswd -nb admin 'S3cretPw9'", `htpasswd -nb admin ${R}`],
    ['htpasswd -b -c', 'htpasswd -b -c f admin S3cretPw9', `htpasswd -b -c f admin ${R}`],
    ['htpasswd -c -b', 'htpasswd -c -b f admin S3cretPw9', `htpasswd -c -b f admin ${R}`],
    ['htpasswd -B -b', 'htpasswd -B -b f admin S3cretPw9', `htpasswd -B -b f admin ${R}`],
    ['htpasswd -n -b', 'htpasswd -n -b admin S3cretPw9', `htpasswd -n -b admin ${R}`],
    ['htpasswd -b -C 10', 'htpasswd -b -C 10 f admin S3cretPw9', `htpasswd -b -C 10 f admin ${R}`],
    ['htpasswd -bC10', 'htpasswd -bC10 f admin S3cretPw9', `htpasswd -bC10 f admin ${R}`],
    ['htpasswd, FILE and USER quoted', `htpasswd -cb "my dir/.htpasswd" 'a b' S3cretPw9`, `htpasswd -cb "my dir/.htpasswd" 'a b' ${R}`],
    // sshpass: its own options only (final review of 0.30)
    ['sshpass -f FILE -p', 'sshpass -f f -p S3cretPw9 ssh -p 22 h', `sshpass -f f -p ${R} ssh -p 22 h`],
    ['sshpass -P "…" -p', 'sshpass -P "Password:" -p S3cretPw9 ssh h', `sshpass -P "Password:" -p ${R} ssh h`],
    ['sshpass -pPASSWORD', 'sshpass -pS3cretPw9 ssh -p 22 h', `sshpass -p${R} ssh -p 22 h`],
    ['"sshpass" -p', '"sshpass" -p S3cretPw9 ssh h', `"sshpass" -p ${R} ssh h`],
    // the SSHPASS variable
    ['SSHPASS=', 'export SSHPASS=S3cretPw9', `export SSHPASS=${R}`],
    ["SSHPASS='…' sshpass -e", "SSHPASS='S3cretPw9' sshpass -e ssh h", `SSHPASS='${R}' sshpass -e ssh h`],
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
      // an option's value, a name with a dash, dot, colon or @, the next segment or line (second review of 0.30)
      'ssh -h mongo -p 2222',
      'docker run -it --name mongo -p 27017:27017 mongo',
      'mongo@h -p 2222',
      'echo "a" | mongo-1 -p 2222',
      'sshpass -f pw ssh h ; ssh h "-p 2222"',
      'echo "sshpass;" -p 2222',
      'sshpass -f pw ssh h \\ x\n -p 2222',
      'sshpass -f pw ssh h "\\\n -p 2222',
      'sshpass -f pw ssh h\\\\ && ssh -p 2222 h',
      // a path that is no command, `NAME=` after an option or as one, a reference, mysql -p asking (third review of 0.30)
      'ssh -i ~/.ssh/mongo -p 2222 user@host',
      'ssh -i ~/.ssh/zip -P 2222 user@host',
      'ls /opt/mongo -p 2',
      'docker run --name=mongo -p 27017:27017 mongo',
      'docker run -e HOST=mongo -p 8080:80 app',
      'docker run mongo:7 -p 2222',
      'mysql -p db',
      'mysql -p"$PW" db',
      'sshpass -p "$PW" ssh h',
      'sshpass -p ${PW} ssh h',
      'sshpass -p $(cat f) ssh h',
      'sshpass -p %PW% ssh h',
      "sshpass -p '${secret:pw}' ssh h",
      // a path elsewhere than in bin/ or to NAME.exe, or an option's value; a wrapper option's value (fourth review of 0.30)
      'x /opt/mongo -p 2',
      'x /opt/sshpassexe -p 2',
      'ssh -i /usr/bin/mongo -p 2222',
      'sudo -u mongo ssh -p 2222 h',
      'sudo -E -u mongo ssh -p 2222 h',
      'sudo -g zip x -P 2',
      'env -u mongo x -p 3',
      'timeout -k mongo 5 x -p 3',
      'nice -n mongo x -p 3',
      'stdbuf -o mongo x -p 3',
      'ExecStart=+sshpass -p 2',
      'curl -U "u:$PW" -x p h',
      'smbclient -U "u%$PW" //h/s',
      "lftp -u 'u,%PW%' h",
      // the command sshpass runs, htpasswd's -C value, sshpass in an error (final review of 0.30)
      'sshpass -e ssh -p 2222 admin@host uptime',
      'sshpass -e ssh host mkdir -p /opt/app',
      'sshpass -f FILE ssh -p 2222 h',
      'sshpass -d 3 scp -P 2222 f h:',
      'htpasswd -Cb f admin x',
      'htpasswd -b -c f',
      'bash: sshpass: command not found',
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
  // The redactor replaces the union of every pattern's matches (createRedactor): each match of the
  // patterns before 0.30 lies in one of the spans it replaces, so nothing they hid shows.
  const t = redactSecretManifests(text);
  const spans = mergeSpans(DEFAULT_PATTERNS.flatMap((p) => patternFinder(p)(t)));
  for (const [start, end] of beforeFinders.flatMap((f) => f(t))) {
    if (end === start) continue;
    const i = spans.findIndex(([, e]) => e >= end);
    if (i < 0 || spans[i]![0] > start) assert.fail(`${where}: [${start}, ${end}) not redacted in ${JSON.stringify(t.slice(0, 300))}`);
  }
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
  // a tool's name in a segment (second review of 0.30: reading back word by word took 21 s for 64,000 characters)
  rep('-/mongo '),
  rep('A=/zip '),
  rep('-h mongo '),
  rep('mongo -p '),
  rep('"sshpass -p '),
  rep("'sshpass "),
  rep('sshpass "'),
  rep('-c "redis-cli -a '),
  rep('(zip{zip`zip/zip\\zip '),
  rep('7z.exe -p'),
  rep('mongo \\\n'),
  rep('sshpass \\\r\n -p '),
  'sshpass' + rep(' \\\n'),
  rep('\\"'),
  rep('"a\\'),
  rep('sshpass |'),
  // escaped JSON values and quoted pass values
  'password:\\"' + '\\'.repeat(N),
  rep('password:\\"\\\\\\"'),
  rep('DB_PASS="a '),
  rep('DB_PASS=\\"a '),
  // third review of 0.30: quoted credentials, prefixes, paths, wrappers
  'smbclient' + rep(' -U "a%\\"'),
  'smbclient' + rep(' -U"a%\\'),
  'lftp' + rep(" -u 'a,"),
  'curl' + rep(' -U "a:'),
  'openssl' + rep(' -passin "pass:\\"'),
  rep('\t@sshpass '),
  rep('@-'),
  rep('X=sshpass '),
  rep('a.b=a:'),
  rep('exec:mongo '),
  rep('~/.ssh/mongo '),
  rep('sudo /zip '),
  rep('X=1 /a/'),
  rep('/'),
  rep('sudo -E '),
  rep('env -i mongo -p '),
  rep("sshpass -p '$"),
  rep('sshpass -p %a'),
  "mysql -p'" + 'a'.repeat(N),
  rep(" -u 'a:"),
  rep('masterauth '),
  rep('REDISCLI_AUTH='),
  rep("--password '$"),
  // fourth review of 0.30: bin/ and .exe paths, wrapper options and their values, NAME=- prefixes
  rep(' /usr/bin/'),
  rep('x bin/zip '),
  rep('x /zip.exe '),
  'sudo' + rep(' -E'),
  'sudo' + rep(' -u a'),
  rep('sudo -u '),
  'env -u' + rep(' a'),
  rep('A=-sshpass '),
  'curl' + rep(' -U "a:$'),
  // final review of 0.30: htpasswd's options, sshpass's own options
  rep('htpasswd -c '),
  'htpasswd' + rep(' -b'),
  rep(' -htpasswd'),
  'htpasswd -b' + rep(' -C a'),
  rep('htpasswd -b "a" '),
  rep('htpasswd -b -C '),
  rep(' -sshpass'),
  'sshpass' + rep(' -e'),
  'sshpass' + rep(' -f a'),
  rep('sshpass -P "'),
  rep('sshpass -P"a" '),
  rep('SSHPASS'),
];

describe('the widened patterns stay linear on 200,000-character lines', () => {
  // Each line on its own (a quadratic reading takes minutes for one), the slowest one reported.
  const slowest = (run: (line: string) => void): [number, string] => {
    let worst: [number, string] = [0, ''];
    for (const line of HOSTILE) {
      const t0 = performance.now();
      run(line);
      const ms = performance.now() - t0;
      if (ms > worst[0]) worst = [ms, JSON.stringify(line.slice(0, 30))];
    }
    return worst;
  };
  it('each of them, and the leak scan', (t) => {
    for (const p of DEFAULT_PATTERNS.filter((x) => WIDENED_PATTERN_NAMES.has(x.name ?? ''))) {
      const r = createRedactor([p]);
      const [ms, line] = slowest((l) => r.redact(l));
      t.diagnostic(`${p.name}: at most ${Math.round(ms)} ms (${line})`);
      // secret-after-unicode-space is eight patterns in one.
      assert.ok(ms < (p.name === 'secret-after-unicode-space' ? 4 : 1) * BUDGET_MS, `${p.name}: ${Math.round(ms)} ms on ${line}`);
    }
    const [ms, line] = slowest((l) => scanForLeaks(l));
    t.diagnostic(`scanForLeaks: at most ${Math.round(ms)} ms (${line})`);
    assert.ok(ms < 4 * BUDGET_MS, `scanForLeaks: ${Math.round(ms)} ms on ${line}`);
  });
});

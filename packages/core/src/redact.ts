/**
 * Secret redaction. Each pattern's whole match is replaced with [REDACTED] (all patterns matched on
 * the same text, the union replaced: createRedactor); patterns use lookbehind/lookahead to keep
 * surrounding context (e.g. "Authorization: [REDACTED]"). The
 * regular expressions that backtrack quadratically are read by linear matchers that find exactly
 * the same (redactScan.ts); they stay here as the definition.
 */

import { BARE_FLAG_NAMES, FLAG_NAMES, LINEAR_FINDERS, mergeSpans, PASSWORD_TOOLS, PasswordToolRule, SPACED_KEY_WORDS, SpanFinder, Spans, WRAPPER_VALUE_OPTIONS, WRAPPERS } from './redactScan';

export const REDACTED = '[REDACTED]';

export interface RedactionPattern {
  name?: string;
  /** JavaScript regular expression source. */
  pattern: string;
  /** Regex flags; 'g' is always added. */
  flags?: string;
}

/** A key's closing quote, also escaped (`\"` in escaped JSON). */
const KEY_QUOTE = `(?:\\\\?["'])?`;
/**
 * `sshpass` (the SSHPASS variable) counts before `=` only: `bash: sshpass: command not found` is
 * no key and value.
 */
const SECRET_KEYS = `password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|privatekey|client[_-]?key|credentials?|\\.key|rediscli_auth|sshpass(?=[\\w.-]*${KEY_QUOTE}[ \\t]*=)`;

// Placeholders and shell references (`${secret:X}`, `$(cmd)`, `$env:X`, `%X%`) are not values. A bare
// `$NAME` is not exempt: the patterns are case-insensitive, so it could not be told from `$ecret`.
// A backslash after one ends it only before a quote: `\"${secret:X}\"` in escaped JSON.
const REFERENCE = '(?:\\$\\{[^}\\s"\']*\\}|\\$\\([^)\\r\\n]*\\)|\\$env:\\w+|%[A-Za-z_]\\w*%)(?![^\\s"\',;&\\\\]|\\\\(?!["\']))';
/** A secret value may not be one of these words (e.g. `"token_type": "Bearer"`) or a reference. */
const NOT_A_VALUE = `(?<!\\$\\{(?:secret|secretFile|input|param):)(?!(?:Bearer|Basic|Negotiate|true|false|null|none)\\b)(?!${REFERENCE})`;

/** Marker pattern: redacts the values under `data:` / `stringData:` of Kubernetes Secret manifests. */
const SECRET_MANIFESTS = 'k8s-secret-data';

/** A key's value: a backslash before a quote (`\"` of escaped JSON) ends it. */
const KEY_VALUE = `(?:[^\\s"',;&}\\\\]|\\\\(?!["']))+`;
/**
 * A value after `\"` (or `\'`, q) up to the `\"` that closes it, as redactScan.ts `escapedValueEnd`
 * reads it. A run of backslashes before q is read whole: 4m+3 of them are an escaped quote in the
 * value (`s3c\\\"ret`: the JSON was escaped twice), 4m+1 the value's 4m backslashes then the
 * closing `\"`, an even number a bare quote (no value). Before any other character, the run is in
 * the value. The closing `\"` is followed by what may follow a string in JSON or a shell (ESC_CLOSES),
 * else this is no escaped JSON and there is no value: it doesn't run on over a secret after it
 * (`\"a b, sh -c '-token='x\"y'`).
 */
const ESCAPED_VALUE = (q: string): string =>
  `(?:[^${q}\\\\\\r\\n]|\\\\+(?=[^${q}\\\\\\r\\n])|(?:\\\\{4})*\\\\{3}${q}|(?:\\\\{4})+(?=\\\\${q}))+(?=\\\\${q}${ESC_CLOSES})`;
/** `, : } ] ) ; & |`, a space, a quote, a backslash or the text's end. */
const ESC_CLOSES = `(?:[,:}\\]);&|\\s"'\\\\]|$)`;
/**
 * What may follow a `\"` that closes its quote: `;`, `&`, `|`, a space or the text's end
 * (`"C:\secrets\"; az login …`, a Windows path that ends in `\`). Before anything else, `\"` is an
 * escaped quote (`"abc\"def"`).
 */
const CLOSES = `(?:[;&|\\s]|$)`;
/**
 * The rest of a value in "…" up to the closing quote: with backslash escapes (`"abc\"def"`), but a
 * `\"` before CLOSES closes it; else (a backslash before the line's end) up to the next `"` as before.
 */
const DQ_REST = `(?:(?:[^"\\\\\\r\\n]|\\\\(?="${CLOSES})|\\\\(?!"${CLOSES})[^\\r\\n])+|[^"\\r\\n]+)(?=")`;
/** In '…', no escapes (sh, PowerShell): up to the next `'`. */
const SQ_REST = `[^'\\r\\n]+(?=')`;
/**
 * A value in quotes after `key` (the look-behind's source up to the quote), as redactScan.ts
 * `quotedValueEnd` reads it: after `"` DQ_REST, after `'` SQ_REST; after `\"` or `\'` (escaped
 * JSON), up to the `\"` or `\'` that closes it (ESCAPED_VALUE).
 */
const quotedAfter = (key: string, notValue = ''): string => quotedAlternatives(key, notValue).join('|');
/** quotedAfter's alternatives, in its order: after `"`, `\"`, `'` and `\'` (redactScan.ts QUOTE_OPENINGS). */
const quotedAlternatives = (key: string, notValue = ''): string[] =>
  ['"', "'"].flatMap((q) => [`(?<=${key}${q})${notValue}${q === '"' ? DQ_REST : SQ_REST}`, `(?<=${key}\\\\${q})${notValue}${ESCAPED_VALUE(q)}`]);
/**
 * A flag's value: in "…" not starting with `$` (the shell expands it) or a REFERENCE; in '…' not
 * starting with a REFERENCE (`'$3cret'` is literal); else a word not starting with `-`, `$` or a
 * REFERENCE (`%3cret` is a value, `%PW%` is not).
 */
const FLAG_VALUE = `(?:"(?!\\$)(?!${REFERENCE})[^"\\r\\n]*"|'(?!${REFERENCE})[^'\\r\\n]*'|(?![-$])(?!${REFERENCE})[^\\s"']+)`;
/**
 * The rest of a quoted `user:PASSWORD` (or `pass:PASSWORD`) after the user part, up to the closing
 * quote, as quotedAfter reads it (DQ_REST, SQ_REST). It doesn't start with a space, nor with a
 * reference as FLAG_VALUE reads one (in "…" `$` too).
 */
const QUOTED_REST = (q: string): string => (q === '"' ? `(?!\\s)(?!\\$)(?!${REFERENCE})${DQ_REST}` : `(?!\\s)(?!${REFERENCE})${SQ_REST}`);
/**
 * The user part of a quoted `-u "user:PASSWORD"`: a whole `${…}` reference (`"${input:USER}:…"`,
 * the colon inside it is no separator), or a word with no colon that isn't one.
 */
const QUOTED_USER = `(?:\\$\\{[^}\\s"']*\\}|(?!\\$\\{[^}\\s"']*\\}:)[^\\s:"']+)`;
/** Where Redis's settings count without dashes (redactScan.ts BARE_FLAG_NAMES): a line's start, after blanks, `#`/`;` or `- `, or after `config set`. */
const BARE_FLAG_START = '(?:(?:^|[\\r\\n])[ \\t]*(?:[#;]+[ \\t]*|-[ \\t]+)?|\\bconfig[ \\t]+set[ \\t]+)';
const SECRET_KEY = `\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*${KEY_QUOTE}[ \\t]*[:=][ \\t]*`;
const PASS_KEY = `(?:^|[^A-Za-z0-9])(?:[\\w.-]*[_.-])?pass${KEY_QUOTE}[ \\t]*[:=][ \\t]*`;
/** A key's value out of quotes (or right after the opening one), as secret-key-value reads it. */
const bareAfter = (key: string): string => `(?<=${key}${KEY_QUOTE})${NOT_A_VALUE}${KEY_VALUE}`;

/**
 * Built-in patterns found in parts, by name: each alternative of the pattern on its own, on the whole
 * text, besides the whole pattern; what they all find is the pattern's (their union). One reading of
 * a value can run over the start of the next key's value: in `password="C:\keys\", token='a"b'` the
 * `"…"` reading runs to the `"` inside the token, and the regular expression, resuming after that
 * match, never tries the token's `'…'` reading at its own start. Found apart, that reading is found
 * too, and everything the whole pattern finds stays found. Each part has its linear matcher
 * (redactScan.ts LINEAR_PARTS, in this order after the whole pattern).
 */
const SPLIT_PATTERNS = new Map<string, readonly string[]>();
function splitPattern(name: string, alternatives: readonly string[], flags: string): RedactionPattern {
  SPLIT_PATTERNS.set(name, alternatives);
  return { name, pattern: alternatives.join('|'), flags };
}

const BASE_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'pem-private-key',
    pattern: '(?<=-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\\s\\S]+?(?=-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
  },
  // Structural (see redactSecretManifests); the regex itself never matches.
  { name: SECRET_MANIFESTS, pattern: '(?!)' },
  {
    name: 'authorization-header',
    // `Authorization: …` runs to the end of the line; `Authorization=…` (hashtables, query strings) stops at , ; } &
    pattern: '(?<=\\b(?:Proxy-)?Authorization["\']?[ \\t]*:[ \\t]*)[^\\s"\'][^\\r\\n"\']*|(?<=\\b(?:Proxy-)?Authorization["\']?[ \\t]*=[ \\t]*)[^\\s"\'][^\\r\\n"\',;}&]*',
    flags: 'i',
  },
  {
    name: 'cookie-header',
    pattern: '(?<=\\b(?:Set-)?Cookie["\']?[ \\t]*[:=][ \\t]*)[^\\s"\'][^\\r\\n"\']*',
    flags: 'i',
  },
  {
    name: 'bearer-token',
    // A token has a digit or a symbol, so "Bearer expires: 300" or "Bearer authentication" stay readable.
    pattern: '(?<=\\bBearer[ \\t]+)(?=[A-Za-z0-9\\-._~+/]*[0-9._~+/-])[A-Za-z0-9\\-._~+/]{8,}=*',
    flags: 'i',
  },
  {
    name: 'jwt',
    pattern: '\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}(?:\\.[A-Za-z0-9_-]*)*',
  },
  // password = "Hunter 2 with spaces" → the whole quoted value; {"password": "a\"b"} and
  // {\"password\":\"…\"} (escaped JSON) too
  splitPattern('secret-key-value-quoted', quotedAlternatives(SECRET_KEY, NOT_A_VALUE), 'i'),
  { name: 'secret-key-value', pattern: bareAfter(SECRET_KEY), flags: 'i' },
  // DB_PASS=…, $env:KC_PASS = "…", pass: … (but not bypass/compass); in quotes, the whole value
  // (DB_PASS="p@ss w0rd", DB_PASS=\"…\")
  splitPattern('pass-key-value', [...quotedAlternatives(PASS_KEY, NOT_A_VALUE), bareAfter(PASS_KEY)], 'i'),
  {
    name: 'secret-flag-value',
    // --password value, --client-secret "value", --requirepass/requirepass value (Redis), -p value
    // after login, mysql -pValue, curl -u user:pass and -u "user:pass"
    pattern:
      `(?<=(?:(?:^|\\s)--?(?:${FLAG_NAMES.join('|')})|${BARE_FLAG_START}(?:${BARE_FLAG_NAMES.join('|')}))[ \\t]+)${FLAG_VALUE}` +
      '|(?<=\\blogin\\b[^\\r\\n]*?\\s-p[ \\t]*)(?!-)[^\\s"\']+' +
      '|(?<=\\bmysql\\b[^\\r\\n]*?\\s-p)[^\\s"\']+' +
      '|(?<=(?:^|\\s)(?:-u|--user)[ \\t]+[^\\s:"\']+:)[^\\s"\']+' +
      ['"', "'"].map((q) => `|(?<=(?:^|\\s)(?:-u|--user)[ \\t]+${q}${QUOTED_USER}:)${QUOTED_REST(q)}`).join(''),
    flags: 'i',
  },
  {
    name: 'keycloak-client-secret',
    // {"type":"secret","value":"7f3a…"} and "client secret … <uuid>"
    pattern:
      '(?<="type"[ \\t]*:[ \\t]*"secret"[ \\t]*,[ \\t]*"value"[ \\t]*:[ \\t]*")[^"]+' +
      '|(?<=\\bsecret\\b[^\\r\\n]{0,40}?)\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    flags: 'i',
  },
  {
    name: 'url-credentials',
    // https://user:PASSWORD@host, redis://:PASSWORD@host (no user)
    pattern: '(?<=\\b[a-z][a-z0-9+.-]*://[^/\\s:@]*:)[^/\\s@]+(?=@)',
    flags: 'i',
  },
  // Base64 of "-----BEGIN" (encoded keys/certs in Secret data) and of '{"auths"' (docker config).
  { name: 'base64-pem', pattern: '\\bLS0tLS1CRUdJTi[A-Za-z0-9+/=]+' },
  { name: 'base64-dockerconfig', pattern: '\\beyJhdXRocyI6[A-Za-z0-9+/=]+' },
  { name: 'openshift-token', pattern: '\\bsha256~[A-Za-z0-9_-]{20,}' },
  { name: 'github-token', pattern: '\\bgh[pousr]_[A-Za-z0-9]{30,}' },
  { name: 'gitlab-token', pattern: '\\bglpat-[A-Za-z0-9_-]{20,}' },
  { name: 'npm-token', pattern: '\\bnpm_[A-Za-z0-9]{36}\\b' },
  { name: 'anthropic-openai-key', pattern: '\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}' },
  { name: 'slack-token', pattern: '\\bxox[abposr]-[A-Za-z0-9-]{10,}' },
  { name: 'gcp-api-key', pattern: '\\bAIza[0-9A-Za-z_-]{35}\\b' },
  { name: 'gcp-oauth-token', pattern: '\\bya29\\.[0-9A-Za-z_-]{20,}' },
  { name: 'azure-storage-key', pattern: '(?<=\\b(?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}', flags: 'i' },
  { name: 'azure-sas-signature', pattern: '(?<=[?&]sig=)[A-Za-z0-9%+/=]{20,}' },
  { name: 'aws-access-key-id', pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
];

/** Every JavaScript space but the line ends: the widened patterns' blank, where the ones above read `[ \t]`. */
const WS = '[^\\S\\r\\n\\u2028\\u2029]';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = (name: string): RedactionPattern => BASE_PATTERNS.find((p) => p.name === name)!;
const quotedHeader = (name: string): string => quotedAfter(`\\b${name}${KEY_QUOTE}${WS}*[:=]${WS}*`);

/** A blank within a line, `[^\S\r\n]`. */
const BL = '[^\\S\\r\\n]';
/*
 * password-flag-tool reads a line in command segments, as a shell does, simply: out of quotes,
 * `|`, `;` and `&` (`&&`, `||` too) end one, and so does the line's end. "…" (with `\"` and `\\`
 * escaped) and '…' are quotes; one left open runs to the line's end. A tool counts where its name
 * is a word of its own, before a blank or a quote (`mongo-1`, `app.zip`, `mongo:7` don't count):
 * - at the segment's start, or after a blank, a quote, `(`, a backtick or `{`, but not as an
 *   option's value: after `-X` or `--name` and blanks (`docker run --name mongo -p 27017:27017`),
 *   unless that option is a wrapper's (`sudo -E -H sshpass`, `env -i redis-cli`) that takes no
 *   value (`sudo -u mongo ssh -p 2222`: WRAPPER, redactScan.ts WRAPPERS);
 * - out of quotes, after a prefix that starts a word (at the segment's start or after a blank) that
 *   is no option's value: `@` or `-` (a Makefile recipe's `@sshpass`), `NAME=`, `NAME=-`, `NAME=@`
 *   or `NAME:` (`ExecStart=sshpass`, `ExecStart=-sshpass`, `exec:sshpass`; not `--name=mongo`);
 * - after a path's `/` or `\`: in quotes anywhere (`& "C:\Program Files\7-Zip\7z.exe"`), out of
 *   quotes where the path is in command position: at the segment's start (after blanks), after a
 *   quote, `(`, a backtick or `{`, or after a wrapper (and its options) or `NAME=value` and blanks
 *   (`/usr/bin/sshpass`, `sudo -E /usr/bin/sshpass`); or after a blank where the path is no
 *   option's value and the tool is in a `bin/` (`bin\`) directory or named `NAME.exe`
 *   (`kubectl exec p -- /usr/bin/redis-cli`, `cmd /c C:\Tools\7z.exe`; not `ssh -i ~/.ssh/mongo
 *   -p 2222`, `ls /opt/mongo -p 2`).
 * Its flag counts anywhere after it in the same segment, in quotes too.
 *
 * The linear matcher (redactScan.ts toolsBefore) also reads a line that ends in `\` out of quotes
 * as going on (`redis-cli -h h \` then `  -a …`), and a flag right after that line break. This
 * regular expression doesn't: it reads one line at a time, so the two agree on text without such
 * a line (test/redactScan.test.ts compares them only there, and tests continued lines apart).
 */
/** Out of quotes: a character that neither ends a segment nor opens a quote. */
const OUT_CHAR = `[^\\r\\n|;&"']`;
/**
 * In "…": a character, `\\`, `\"` (not before CLOSES: then the `"` closes, as in DQ_REST), or a
 * backslash before any other character.
 */
const DQ_CHAR = `(?:[^"\\\\\\r\\n]|\\\\\\\\|\\\\"(?!${CLOSES})|\\\\(?=[^"\\\\\\r\\n]|"${CLOSES}))`;
const SQ_CHAR = `[^'\\r\\n]`;
const SEGMENT_ITEM = `(?:${OUT_CHAR}|"${DQ_CHAR}*"|'${SQ_CHAR}*')`;
/** From out of quotes to a place in the same segment, maybe in a quote opened on the way. */
const OUT_TO = `${SEGMENT_ITEM}*(?:"${DQ_CHAR}*|'${SQ_CHAR}*)?`;
/** What a tool's name may follow out of quotes, if it doesn't start its segment. */
const TOOL_LEFT = `(?<=[\\s"'(\`{])`;
/** In quotes, also a path's `/` or `\` (`"C:\…\7z.exe"`). */
const TOOL_LEFT_QUOTED = `(?<=[\\s"'(\`{/\\\\])`;
/**
 * A wrapper (redactScan.ts WRAPPERS) and blanks, then its options, each with blanks: `-[\w-]+`
 * words, and those that take a value (WRAPPER_VALUE_OPTIONS) with that value's word. It runs the
 * next word as a command.
 */
const wrapperContext = (w: string): string => {
  const v = WRAPPER_VALUE_OPTIONS[w];
  const option = v === undefined ? '-[\\w-]+' : `(?:-[${v}]\\s+\\S+|(?!-[${v}]\\s)-[\\w-]+)`;
  return `(?<![\\w.-])${w}\\s+(?:${option}\\s+)*`;
};
const WRAPPER = `(?:${WRAPPERS.map(wrapperContext).join('|')})`;
/** A wrapper's option that takes a value (`sudo -u`), where WRAPPER allows it. */
const WRAPPER_VALUE_OPTION = `(?:${WRAPPERS.filter((w) => WRAPPER_VALUE_OPTIONS[w] !== undefined)
  .map((w) => `${wrapperContext(w)}-[${WRAPPER_VALUE_OPTIONS[w]}]`)
  .join('|')})`;
/**
 * Not an option's value: no `-X` or `--name` (a whole word, not after WRAPPER) and blanks right
 * before, nor a wrapper's option that takes a value.
 */
const NOT_OPTION_VALUE = `(?<!(?<![^\\s])(?<!${WRAPPER})(?:-\\w|--\\w[\\w-]*)\\s+)(?<!${WRAPPER_VALUE_OPTION}\\s+)`;
/** What may start a word before a tool's name, out of quotes: `@`, `-`, `@-`, `-@`, `NAME=`, `NAME=-`, `NAME=@`, `NAME:`. */
const TOOL_PREFIX = `(?:@-?|-@?|[A-Za-z_][\\w.-]*(?:=[-@]?|:))`;
/** A path's character out of quotes. */
const PATH_CHAR = `[^\\s"'|;&(\`{]`;
/** `NAME=value`, a whole word. */
const ASSIGN = `(?<![^\\s])[A-Za-z_][\\w.-]*=[^\\s"'|;&]*`;
/** Command position, for a path out of quotes: the segment's start (after blanks), a quote, `(`, a backtick, `{`, a wrapper (and its options) or `NAME=value`. */
const COMMAND_LEFT = `(?<=(?:^|[\\r\\n|;&])${BL}*|["'(\`{]|${WRAPPER}|${ASSIGN}\\s+)`;
/** A piece of a word among a tool's own options: a character but a space, quote, `|`, `;` or `&`, or a whole quote (`-P "Password:"`). */
const OWN_W = `(?:[^\\s"'|;&]|"[^"\\r\\n]*"|'[^'\\r\\n]*')`;
/**
 * After a tool's name (PasswordToolRule `ownOptions`, redactScan.ts `ownOptionStarts`): its
 * options, each after blanks: `-X` (X one of `letters`, the whole word) then blanks and its value,
 * or another word that starts with `-`. Its flag counts only at the start of one of these, so not
 * in the command it runs (`sshpass -e ssh -p 2222 host`).
 */
const ownOptionRun = (letters: string): string =>
  `(?:${BL}+(?:-[${letters}]${BL}+${OWN_W}+|-(?![${letters}](?![^\\s|;&]))${OWN_W}*))*${BL}*`;
/** `word` in any case: `[Ss][Cc]…` (the pattern has no i flag: `-p` and `-P` differ). */
const anyCase = (word: string): string => word.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const toolRule = (r: PasswordToolRule): string => {
  const word = (w: string): string => (r.anyCase ? anyCase(escapeRe(w)) : escapeRe(w));
  const tools = `(?:${r.tools.map(word).join('|')})`;
  const name = `${tools}(?:\\.[Ee][Xx][Ee])?(?=[\\s"'])`;
  // Out of quotes: where a command can start, after a prefix, after a path in command position, or
  // after a path that is no option's value, in a `bin/` directory or as `NAME.exe`.
  const pathNov = `${SEGMENT_ITEM}*(?<=\\s)${NOT_OPTION_VALUE}${PATH_CHAR}*`;
  const out =
    `(?:(?:(?:${SEGMENT_ITEM}*${TOOL_LEFT})?${NOT_OPTION_VALUE}` +
    `|(?:${SEGMENT_ITEM}*(?<=\\s))?${NOT_OPTION_VALUE}${TOOL_PREFIX}` +
    `|${SEGMENT_ITEM}*${COMMAND_LEFT}${PATH_CHAR}*[/\\\\]` +
    `|${pathNov}bin[/\\\\])${name}` +
    `|${pathNov}[/\\\\]${tools}\\.[Ee][Xx][Ee](?=[\\s"']))`;
  const quoted = `${TOOL_LEFT_QUOTED}${NOT_OPTION_VALUE}${name}`;
  // The line's start, the segments before, then the tool out of quotes, in "…" or in '…', and on to
  // a blank and the flag: anywhere later in the segment, or (ownOptions) among the tool's options.
  const run = r.ownOptions === undefined ? undefined : ownOptionRun(r.ownOptions);
  const flag =
    `(?<![^\\r\\n])(?:${SEGMENT_ITEM}*[|;&])*` +
    (run === undefined
      ? `(?:${out}${OUT_TO}` + `|${SEGMENT_ITEM}*"${DQ_CHAR}*${quoted}${DQ_CHAR}*(?:"${OUT_TO})?` + `|${SEGMENT_ITEM}*'${SQ_CHAR}*${quoted}${SQ_CHAR}*(?:'${OUT_TO})?)`
      : `(?:${out}${run}|${SEGMENT_ITEM}*"${DQ_CHAR}*${quoted}"?${run}|${SEGMENT_ITEM}*'${SQ_CHAR}*${quoted}'?${run})`) +
    `${BL}(?:${r.flags.map(word).join('|')})`;
  const gap = r.space && r.glued ? `${WS}*` : r.space ? `${WS}+` : '';
  // `user<split>PASSWORD` or `<prefix>PASSWORD`: a word, or in quotes up to the closing one.
  const credential = (before: string): string =>
    [`(?<=${flag}${gap}${before})[^\\s"']+`, ...['"', "'"].map((q) => `(?<=${flag}${gap}${q}${before})${QUOTED_REST(q)}`)].join('|');
  if (r.split !== undefined) return credential(`[^\\s${escapeRe(r.split)}"']+${escapeRe(r.split)}`);
  if (r.prefix !== undefined) return credential(escapeRe(r.prefix));
  return `(?<=${flag}${gap})${FLAG_VALUE}`;
};
/*
 * `htpasswd -b FILE USER PASSWORD`, `htpasswd -nb USER PASSWORD`: htpasswd reads its options with
 * getopt (`cnmspdBbDi25C:r:v`), in one word or several (`-c -b`, `-bc`, `-B -b`); `-C` and `-r`
 * take a value, the rest of their word or the next word (`-C 10`, `-bC10`). With `b` among them,
 * the password is the word after FILE and USER (after USER with `n`), read as FLAG_VALUE (quoted or
 * a word, references kept); FILE and USER may be quoted. redactScan.ts `htpasswdStarts` reads the
 * same.
 */
/** An option letter of htpasswd's that takes no value (`C` and `r` take one). */
const HT_LETTER = '[0-9A-BD-Za-qs-z]';
/** An option word, then blanks. */
const HT_OPTION = `-(?=[0-9A-Za-z])${HT_LETTER}*(?:[Cr](?:\\S+|${WS}+\\S+))?${WS}+`;
/** FILE or USER, then blanks: in quotes, or a word that doesn't start with `-`. */
const HT_ARG = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"'-][^\\s"']*)${WS}+`;
/** One of the options (from their start) has `letter` before any value. */
const htHas = (letter: string): string => `(?:${HT_OPTION})*-${HT_LETTER}*${letter}`;
const HTPASSWD =
  `(?<=\\bhtpasswd${WS}+(?=${htHas('b')})(?:(?!${htHas('n')})(?:${HT_OPTION})+${HT_ARG}|(?=${htHas('n')})(?:${HT_OPTION})+)${HT_ARG})` + FLAG_VALUE;
const SPACED_KEY = `\\b(?:(?:${SPACED_KEY_WORDS.join('|')})${WS}+key|pass${WS}*phrase)${KEY_QUOTE}${WS}*[:=]${WS}*`;

/**
 * Patterns added in 0.30 for what the ones above missed. Only added: the redactor replaces the
 * union of all matches, and the leak scan reports them after the others, so everything those find
 * stays found; each has a linear matcher (redactScan.ts).
 */
const WIDENED_PATTERNS: readonly RedactionPattern[] = [
  // "Authorization": "Basic …", Authorization: 'Bearer …', {"Cookie": "session=…"}: the value in its quotes.
  { name: 'authorization-header-quoted', pattern: quotedHeader('(?:Proxy-)?Authorization'), flags: 'i' },
  { name: 'cookie-header-quoted', pattern: quotedHeader('(?:Set-)?Cookie'), flags: 'i' },
  // The patterns that read blanks around a separator or after a flag, with Unicode spaces (no-break, ideographic…) as blanks.
  {
    name: 'secret-after-unicode-space',
    pattern: ['authorization-header', 'cookie-header', 'bearer-token', 'secret-key-value-quoted', 'secret-key-value', 'pass-key-value', 'secret-flag-value', 'keycloak-client-secret']
      .map((n) => base(n).pattern.split('[ \\t]').join(WS))
      .join('|'),
    flags: 'i',
  },
  // sshpass -p PASSWORD, redis-cli -a PASSWORD, ldapsearch -w PASSWORD, smbclient -U user%PASSWORD… (PASSWORD_TOOLS)
  { name: 'password-flag-tool', pattern: [...PASSWORD_TOOLS.map(toolRule), HTPASSWD].join('|') },
  // api key: …, secret key = …, "private key": "…", passphrase: … (key names SECRET_KEYS misses)
  splitPattern('secret-key-value-spaced', [...quotedAlternatives(SPACED_KEY, NOT_A_VALUE), bareAfter(SPACED_KEY)], 'i'),
];

/** Names of the widened patterns: the leak scan reports what they find last, and only when it looks like a secret. */
export const WIDENED_PATTERN_NAMES: ReadonlySet<string> = new Set(WIDENED_PATTERNS.map((p) => p.name!));

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [...BASE_PATTERNS, ...WIDENED_PATTERNS];

/**
 * Redact every value under `data:` / `stringData:` when the text contains a Kubernetes Secret
 * (`oc get secret -o yaml|json`), also in escaped JSON (`\"kind\":\"Secret\"`, `\"data\":{…}` in
 * kubectl's last-applied-configuration annotation). Key names are kept, so the output stays useful.
 */
export function redactSecretManifests(text: string): string {
  if (!/(?:\\?["'])?kind(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?Secret\b/.test(text)) return text;
  // YAML: an indented block under data:/stringData:
  let out = text.replace(/^([ \t]*)(data|stringData):[ \t]*(\r?\n)((?:\1[ \t]+[^\r\n]*(?:\r?\n|$))+)/gm, (_m, indent: string, key: string, nl: string, block: string) => {
    const redacted = block.replace(/^([ \t]+[^\s:#][^:\r\n]*:[ \t]*)(?:\|[-+]?|>[-+]?)?[ \t]*(\S[^\r\n]*)?$/gm, (line: string, k: string, v?: string) =>
      v === undefined || v.startsWith('[REDACTED]') ? line : `${k}${REDACTED}`,
    );
    return `${indent}${key}:${nl}${redacted}`;
  });
  // JSON: "data": { "k": "v", … }, and escaped: \"data\":{\"k\":\"v\"} (a value up to the \" that ends it)
  out = out.replace(/(\\?"(?:data|stringData)\\?"[ \t]*:[ \t]*\{)([^{}]*)(\})/g, (_m, open: string, body: string, close: string) =>
    open +
    body.replace(/(\\?"(?:[^"\\\r\n]|\\[^"\r\n])+\\?"[ \t]*:[ \t]*)(?:"[^"]*"|\\"(?:[^"\\]|\\(?!"))*\\")/g, (m: string, key: string) =>
      m.startsWith('\\', key.length) ? `${key}\\"${REDACTED}\\"` : `${key}"${REDACTED}"`,
    ) +
    close,
  );
  return out;
}

export interface Redactor {
  redact(text: string): string;
  /** Patterns that failed to compile, with the reason. */
  errors: string[];
}

function normalizeFlags(flags: string | undefined): string {
  const set = new Set((flags ?? '').replace(/[gy]/g, '').split(''));
  set.add('g');
  return [...set].join('');
}

export function compilePattern(p: string | RedactionPattern): RegExp {
  const spec = typeof p === 'string' ? { pattern: p } : p;
  return new RegExp(spec.pattern, normalizeFlags(spec.flags));
}

const patternKey = (p: string | RedactionPattern): string =>
  typeof p === 'string' ? `g/${p}` : `${[...normalizeFlags(p.flags)].sort().join('')}/${p.pattern}`;

/** Built-in patterns read in linear time (redactScan.ts), by pattern and flags: the same regular expression of yours is too. */
const LINEAR = new Map<string, SpanFinder>();
/** The alternatives of the patterns found in parts (SPLIT_PATTERNS), by pattern and flags. */
const SPLIT = new Map<string, readonly string[]>();
for (const p of DEFAULT_PATTERNS) {
  const find = p.name === undefined ? undefined : LINEAR_FINDERS.get(p.name);
  if (find) LINEAR.set(patternKey(p), find);
  const parts = p.name === undefined ? undefined : SPLIT_PATTERNS.get(p.name);
  if (parts) SPLIT.set(patternKey(p), parts);
}

/**
 * The regular expressions that define what `p` finds: its own, and for a built-in pattern found in
 * parts (SPLIT_PATTERNS) each of its alternatives too, all on the whole text; the union of their
 * matches is what it finds (patternFinder, in linear time). Throws if `p` doesn't compile.
 */
export function patternRegexes(p: string | RedactionPattern): RegExp[] {
  const parts = SPLIT.get(patternKey(p)) ?? [];
  const flags = typeof p === 'string' ? undefined : p.flags;
  return [compilePattern(p), ...parts.map((pattern) => compilePattern({ pattern, flags }))];
}

/**
 * Where `p` matches in `text` ([start, end), in order, as `text.matchAll` finds them; for a pattern
 * found in parts, the union of its parts' matches, patternRegexes): a built-in pattern in linear
 * time, any other with its regular expression. Throws if that doesn't compile.
 */
export function patternFinder(p: string | RedactionPattern): SpanFinder {
  const linear = LINEAR.get(patternKey(p));
  if (linear) return linear;
  const re = compilePattern(p);
  return (text) => [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** The union of spans (redactScan.ts, where the patterns found in parts merge theirs too). */
export { mergeSpans };

/** The union of two sorted lists of spans that don't overlap among themselves, as mergeSpans gives it. */
function unionSorted(a: Spans, b: Spans): Spans {
  const out: Spans = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i]![0] <= b[j]![0]) ? a[i++]! : b[j++]!;
    if (next[1] <= next[0]) continue;
    const last = out[out.length - 1];
    if (last && next[0] <= last[1]) last[1] = Math.max(last[1], next[1]);
    else out.push([next[0], next[1]]);
  }
  return out;
}

/** `text` with every span (in order, not overlapping) but the empty ones replaced by REDACTED. */
function replaceSpans(text: string, spans: Spans): string {
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    if (end === start) continue;
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Every pattern (yours too: each replaces its whole match) is matched on the same text, and the
 * union of what they find is replaced, each merged span once (as redactLeaks does). Applied one
 * after another, a long match of one pattern (a quoted value read too far) removed the key the
 * next one needed, and that secret stayed.
 */
export function createRedactor(patterns: ReadonlyArray<string | RedactionPattern>): Redactor {
  const finders: SpanFinder[] = [];
  const errors: string[] = [];
  let manifests = false;
  for (const p of patterns) {
    if (typeof p !== 'string' && p.name === SECRET_MANIFESTS) {
      manifests = true;
      continue;
    }
    try {
      // Zero-length matches are left alone (mergeSpans) so a careless pattern can't splatter the text.
      finders.push(patternFinder(p));
    } catch (e) {
      const label = typeof p === 'string' ? p : (p.name ?? p.pattern);
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    errors,
    redact(text: string): string {
      const t = manifests ? redactSecretManifests(text) : text;
      // Each finder's spans are in order and don't overlap (as matchAll finds them): merged in pairs.
      let lists = finders.map((find) => find(t)).filter((l) => l.length > 0);
      if (lists.length === 0) return t;
      if (lists.length === 1) lists = [unionSorted(lists[0]!, [])];
      while (lists.length > 1) {
        const next: Spans[] = [];
        for (let k = 0; k < lists.length; k += 2) next.push(k + 1 < lists.length ? unionSorted(lists[k]!, lists[k + 1]!) : lists[k]!);
        lists = next;
      }
      return replaceSpans(t, lists[0]!);
    },
  };
}

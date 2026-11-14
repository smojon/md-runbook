# md-runbook library server

A small service next to the [web app's container](../web/README.md). The web app serves the
team library, a folder of runbooks, read-only at `/runbooks/`. This server is the only thing
that writes to that folder, and only signed runbooks go in. It also collects **run summaries**
and turns **Alertmanager alerts** into links that open the right runbook. It runs behind the
same reverse proxy as the web app, on the same name:

| Path | What | Token |
| --- | --- | --- |
| `POST /v1/library/runbooks/<path>` | Publish a signed runbook | upload |
| `DELETE /v1/library/runbooks/<path>` | Remove one (only with `LIBRARY_ALLOW_DELETE=true`) | upload |
| `POST /v1/runs` | A run summary from VS Code, the app, the command line or md-runbook-gate | runs or gate, when set |
| `GET /v1/runs?runbook=…` | Recent runs | read |
| `GET /v1/runs/last-green?runbook=…` | "Last ran green by X at T", verified or not | read |
| `POST /v1/alerts` | Alertmanager's webhook | alerts, when set |
| `GET /v1/alerts/recent` | Recent alerts and their runbook links | read |
| `GET /v1/server-info`, `GET /healthz` | What it serves (`capabilities`), and whether it is up | none |

Each part is on when its main setting is there: publishing with `LIBRARY_DIR`, run summaries
with `RUNS_DIR`, alerts with `ALERT_MAP`.

## Publishing

```sh
export MD_RUNBOOK_LIBRARY_TOKEN=…        # an upload token
md-runbook sign ops/restart-api.md --key ~/.ssh/id_ed25519
md-runbook publish ops/restart-api.md --library https://runbooks.example.net --path ops/restart-api.md
```

The same request without the command line:

```sh
curl -sS -X POST --data-binary @ops/restart-api.md \
  -H "Authorization: Bearer $MD_RUNBOOK_LIBRARY_TOKEN" \
  https://runbooks.example.net/v1/library/runbooks/ops/restart-api.md
```

The server takes a runbook only when **all** of these hold. It answers `201` with the signed
name, version, signer and manifest hash, or the reason it refused:

1. **Signed by the library's signers.** A signature, or a co-signer's, must verify against
   `LIBRARY_ALLOWED_SIGNERS` (OpenSSH's `allowed_signers`, namespace `md-runbook`), checked with
   `ssh-keygen -Y verify` as md-runbook-gate checks it (`403` otherwise). By default that is the
   `allowed_signers` file in the library folder, the same file the app offers its users to trust.
2. **The whole runbook is signed** ([manifest version 2](../../docs/features/signed-runbooks.md#what-is-signed))
   and nothing changed since signing (outputs, notes and ticked boxes don't count). A runbook
   signed before version 2 has only its bash blocks signed: refused unless `LIBRARY_ACCEPT_V1=true`,
   and then only with its blocks as signed (`422`).
3. **Not expired** (`422`).
4. **Named as its file.** The last part of the signed name is the file name without `.md`:
   `ops/restart-api` fits `restart-api.md` and `restart-api.runbook.md`, as the app checks (`422`).
5. **A higher version** than the one published at that path, and than any published there
   before, even if that file was deleted since (`409`). Sending the same text again answers
   `200` with `"unchanged": true`.
6. **A plain path:** relative, no `..`, `.` or empty parts, no hidden files or folders (`.git`),
   at most 4 folders deep, letters, digits, spaces and `. _ -` in names, a Markdown file (`*.md`,
   so `*.runbook.md` too) (`400`). Folders are made as needed; a path through a symbolic link is
   refused (`409`).
7. **At most `LIBRARY_MAX_BYTES`** (512 KiB by default, `413`).

The file is written atomically (a temporary file next to it, then a rename), so the web app
serves the old text or the new one, never half of it. Then `index.json` is written again: every
runbook in the folder with its title, and `signedOnly` from `LIBRARY_SIGNED_ONLY` (on by default:
the app then opens only runbooks it can verify). A `folder` set by hand for a runbook in
`index.json` is kept. Each publish is logged with the token's name, the path, the signed name,
the version before and after, and the signer.

Run one server per library folder: it serializes its own writes, not another process's.

## Run summaries

Clients send the summary of every run to the address in a runbook's `report-runs:` front matter
([run reports](../../docs/features/run-reports.md)); point it at
`https://runbooks.example.net/v1/runs`. md-runbook-gate sends its own with `report_to` in
`gate.conf` ([signed runbooks](../../docs/features/signed-runbooks.md#run-reports-from-the-gate)).

- **Strict.** A summary must be format version 1 with no field the format doesn't list
  (`runSummaryProblems`), so it can't carry an output or a value; its totals and `green` must
  agree with its steps (`400` otherwise, with the problems).
- **Signed summaries** (the envelope `{summary, signature, signer?}`) are checked against
  `RUNS_ALLOWED_RUNNERS` (allowed_signers format, namespace `md-runbook-run`) with ssh-keygen.
- **Kept append-only**, one JSON line per summary in `RUNS_DIR/runs-YYYY-MM.jsonl`: when it
  arrived, from which address and with which token, the summary, the signature as sent (to check
  again with `md-runbook verify-run`), and how far it can be believed:

  | `trust` | Meaning |
  | --- | --- |
  | `runner-signed` | A key in the allowed runners signed it (`runner` names it). |
  | `gate` | Client `gate`, sent with a gate token: md-runbook-gate's own record of what it ran. |
  | `unverified` | Anything else: what the sender says (`why` says why it isn't verified). |

- `RUNS_REQUIRE_SIGNED=true` refuses `unverified` summaries (`403`).
- With `RUNS_GATE_TOKENS` set, a summary that says `client: "gate"` is refused without a gate
  token, so a client can't pass itself off as a gate.

`GET /v1/runs?runbook=ops/restart-api&limit=50` lists the newest runs of a runbook, newest first;
`runbook=` is a signed name, or a path in the library (`ops/restart-api.md`, which matches the
file name clients send and the signed name a gate sends). Without `runbook=`, every runbook.
`GET /v1/runs/last-green?runbook=…` answers the newest green run, and when that one is not
verified, the newest verified one too:

```json
{ "runbook": "ops/restart-api.md", "last": { … }, "lastVerified": { … },
  "text": "ops/restart-api.md: last ran green by bob at 2026-11-14T09:02:00.000Z (version 7), unverified; last verified green run by ana@example.net at 2026-11-14T09:01:00.000Z (version 7), verified: signed by the runner" }
```

Summaries hold no outputs, parameter values or secrets: the format has no place for them.
They are a convenience view. The tamper-resistant record is the gate's log (syslog forwarded off
the server), and `md-runbook audit` checks run records against it.

## Alerts

Alertmanager sends its webhook to `/v1/alerts`:

```yaml
receivers:
  - name: md-runbook
    webhook_configs:
      - url: https://runbooks.example.net/v1/alerts
        send_resolved: true
        http_config:
          authorization:
            credentials_file: /etc/alertmanager/md-runbook-token   # one of ALERTS_TOKENS
```

`ALERT_MAP` is a JSON file of routes, tried in order; the first whose `alertname` and
`matchers` (Alertmanager's syntax: `=`, `!=`, `=~`, `!~`, regular expressions anchored, RE2)
match takes the alert. [alert-map.example.json](alert-map.example.json):

```json
{ "routes": [
  { "alertname": "KubePodCrashLooping", "matchers": ["namespace=~\"prod-.*\""],
    "runbook": "k8s/crashloop.md", "host": "{{ $labels.cluster }}",
    "params": { "NAMESPACE": "{{ $labels.namespace }}", "POD": "{{ $labels.pod }}" },
    "alertLabels": ["namespace", "pod"] }
] }
```

Templates take `{{ $labels.NAME }}` and `{{ $annotations.NAME }}`. Every link also gets `ALERT`
(the alert's name), `ALERT_FINGERPRINT`, `ALERT_STARTS_AT` and, with `alertLabels`, `ALERT_LABELS`
(`name=value,…`), which a run's summary then carries
([which alert a run answered](../../docs/features/run-reports.md#which-alert-a-run-answered)).
JSON only: YAML would be the image's one more dependency. `kill -HUP` reads the map again (a
broken one keeps the old map; the log says why).

Each alert is recorded, append-only, in `ALERTS_DIR/alerts-YYYY-MM.jsonl` (default
`STATE_DIR/alerts`), with its runbook and the link that opens it:

```
https://runbooks.example.net/open?url=https%3A%2F%2Frunbooks.example.net%2Frunbooks%2Fk8s%2Fcrashloop.md&sha256=…&host=prod-eu-1&p.NAMESPACE=prod-eu&p.POD=api-7f9&p.ALERT=KubePodCrashLooping&p.ALERT_FINGERPRINT=5f3c9e&p.ALERT_STARTS_AT=…
```

`sha256` pins the runbook's text as it is in the library now (`LIBRARY_DIR`); the app refuses
another text. A host that isn't a host name is left out. Alerts no route takes are recorded
too, without a link, so you can see which alerts have no runbook yet. `GET /v1/alerts/recent`
(`limit=`, `alertname=`) lists them. A link only opens a runbook and fills in its parameters: it
never runs anything, and a signed runbook's parameter patterns still apply.

### Push to phones: not built yet

Nothing is sent to phones. The place for it is `notify(firing)` (`ServerOptions.notify` in
[src/server.ts](src/server.ts)), called for each firing alert that has a link; a failure there
is logged and never loses the alert. A push sender needs:

- **Android:** a Firebase project and a service account key (FCM HTTP v1 API).
- **iOS:** an APNs key (`.p8`), its key ID, the team ID and the app's bundle ID, from the Apple
  developer account.
- **Devices:** the app registering its push token with this server (an endpoint and a list of
  devices per person or on-call rotation), which the app doesn't do yet.
- The app opening the link from the notification (it opens `/open?…` links already).

## Run it

Behind a reverse proxy that terminates TLS, on the web app's name.
[compose.example.yml](compose.example.yml) runs the web app, this server and Caddy, with
[Caddyfile.example](Caddyfile.example): Caddy sends `/v1/library/`, `/v1/runs` and `/v1/alerts` here
and everything else to the web app. It doesn't send `/v1/server-info` here: on the web app's
own name that path is the relay's (the web app asks it to find one). The relay
([apps/relay](../relay/README.md)) keeps its own name.

```sh
cd apps/library-server
mkdir -p library config secrets
cp ~/allowed_signers library/allowed_signers      # the signers whose runbooks are published
cp alert-map.example.json config/alert-map.json   # then edit it
for t in upload runs gate read alerts; do openssl rand -hex 32 > secrets/$t; done
sudo chown -R 1000:1000 library secrets           # the server runs as uid 1000
# Edit compose.example.yml (PUBLIC_URL) and Caddyfile.example (your name).
docker compose -f compose.example.yml up -d
curl https://runbooks.example.net/runbooks/index.json
```

The web container reads `library/` read-only; only this server writes it. Without Docker, with
Node 22 and OpenSSH 8.2 or newer:

```sh
npm ci && npm run build
LIBRARY_DIR=/srv/runbooks LIBRARY_UPLOAD_TOKENS=… npm start
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBRARY_DIR` | | The library folder (the one the web app serves at `/runbooks/`). Turns publishing on. |
| `LIBRARY_UPLOAD_TOKENS` | required with `LIBRARY_DIR` | Upload tokens, comma-separated. `_FILE`: one per line. |
| `LIBRARY_ALLOWED_SIGNERS` | `LIBRARY_DIR/allowed_signers` | The signers whose runbooks are published (namespace `md-runbook`). |
| `LIBRARY_ACCEPT_V1` | `false` | Also take runbooks signed before manifest version 2 (only their bash blocks signed). |
| `LIBRARY_ALLOW_DELETE` | `false` | Allow `DELETE`. The highest version stays remembered. |
| `LIBRARY_SIGNED_ONLY` | `true` | `signedOnly` in `index.json`. |
| `LIBRARY_MAX_BYTES` | `524288` | Largest runbook. |
| `RUNS_DIR` | | Where summaries are kept. Turns run summaries on. |
| `RUNS_TOKENS` | none: anyone may send | Tokens clients send (`report-runs-token: ${secret:NAME}`). |
| `RUNS_GATE_TOKENS` | | Tokens of md-runbook-gate (`report_token_file`). |
| `RUNS_READ_TOKENS` | none: reading is off | Tokens that may read runs (and alerts, unless `ALERTS_READ_TOKENS`). |
| `RUNS_ALLOWED_RUNNERS` | | The runners' keys (namespace `md-runbook-run`). |
| `RUNS_REQUIRE_SIGNED` | `false` | Refuse summaries that no known runner signed and no gate sent. |
| `RUNS_MAX_BYTES` | `65536` | Largest summary. |
| `ALERT_MAP` | | The alert map (JSON). Turns alerts on. |
| `PUBLIC_URL` | required with `ALERT_MAP` | The web app's public address, `https://…`: links are `PUBLIC_URL/open?…`. |
| `LIBRARY_PUBLIC_PATH` | `/runbooks/` | Where the web app serves the library on that address. |
| `ALERTS_TOKENS` | none: anyone may send | Tokens Alertmanager sends (`http_config.authorization`). |
| `ALERTS_READ_TOKENS` | `RUNS_READ_TOKENS` | Tokens that may read alerts. |
| `ALERTS_DIR` | `STATE_DIR/alerts` | Where alerts are kept. |
| `ALERTS_MAX_BYTES` | `1048576` | Largest webhook. |
| `STATE_DIR` | `./data` (`/data` in the image) | The highest version published per path, and alerts. |
| `SERVER_HOST`, `SERVER_PORT` | `127.0.0.1`, `8090` | Where it listens (the image: `0.0.0.0`). |
| `TRUST_PROXY` | `false` | The client address is the last `X-Forwarded-For` entry. Only behind your own proxy. |
| `CORS_ORIGINS` | none | Pages on other origins allowed to read answers in a browser. Same origin needs none. |
| `RATE_PER_MINUTE` | `120` | Requests per client address per minute to `/v1/`. |
| `MAX_FAILURES`, `FAIL_WINDOW_SECONDS` | `10`, `600` | Failed token checks per client address before it is refused for the window. |
| `SSH_KEYGEN` | `ssh-keygen` | OpenSSH's ssh-keygen, 8.2 or newer. |

Every token list also takes `NAME_FILE` (Docker secrets). A token is at least 24 characters
(`openssl rand -hex 32`); `label:token` gives it a name in the log (`ci:3f9a…`), otherwise it is
logged by a short hash of itself. Invalid settings stop the server at start (exit 2).

## Security

- **What each token allows.**
  - *Upload:* publish runbooks that pass every check above, and delete them where that is on.
    It can't put an unsigned or altered runbook in, or replace a version with an older one: that
    takes a signer's key, which the server never holds.
  - *Runs:* send summaries. *Gate:* send summaries too, and only it can send `client: "gate"`
    ones, which count as verified. A gate token sits on each gated server, readable by the
    account the gate runs as, so whoever can run commands there can send a summary in the gate's
    name: one token per server, so it can be withdrawn alone.
  - *Read:* read runs and alerts (names, times, results, alert labels; no outputs).
  - *Alerts:* send alerts, which the server only records and turns into links.
- **Tokens** travel only in `Authorization: Bearer`, never in URLs, are compared in constant
  time against every token, and are never logged (only their names). Clients that fail the check
  too often are refused for a while.
- **Signatures** are checked with OpenSSH's ssh-keygen, as md-runbook-gate and the command line
  check them, so every key type works the same everywhere: Ed25519, ECDSA, RSA and FIDO (`sk-`)
  keys, and allowed_signers options such as `valid-before`. The namespaces keep a
  runbook signature (`md-runbook`) and a run summary's (`md-runbook-run`) apart.
- **The library folder** is written only by this server, only below `LIBRARY_DIR`, never through
  a symbolic link, never a hidden file, atomically. The web container mounts it read-only.
- **Limits:** body sizes, requests per client per minute, 30 seconds per request.
- **The container** runs as `node` (uid 1000) on a read-only root with `/tmp` as tmpfs (for
  ssh-keygen's temporary files), all capabilities dropped. It needs no outbound network.
- **What it can't do:** prove that the steps of a summary really ran as it says. A runner's
  signature proves which key sent it; the gate's log is the record of what ran on a gated server.
- **What it stores:** run summaries (who ran what, when, and how it ended) and alert labels. Who
  may read them, and for how long they are kept, is your policy: the files are append-only, one
  per month, to archive or delete as you decide.

## Tests

`npm test` builds the server and runs its tests with real ssh-keygen keys and signatures. The
[Library server workflow](../../.github/workflows/library-server.yml) also builds the image from
the repository root, starts it read-only and probes it from outside.

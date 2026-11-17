# md-runbook library server

A small service next to the [web app's container](../web/README.md). The web app serves the
team library, a folder of runbooks, read-only at `/runbooks/`. This server:

- is the only thing that writes to that folder, and only signed runbooks go in;
- collects **run summaries**;
- turns **Alertmanager alerts** into links that open the right runbook;
- **pushes** firing alerts to the phones registered for them (off until set up).

It runs behind the same reverse proxy as the web app, on the same name:

| Path | What | Token |
| --- | --- | --- |
| `POST /v1/library/runbooks/<path>` | Publish a signed runbook | upload |
| `DELETE /v1/library/runbooks/<path>` | Remove one (only with `LIBRARY_ALLOW_DELETE=true`) | upload |
| `POST /v1/runs` | A run summary from VS Code, the app, the command line or md-runbook-gate | runs or gate, when set |
| `GET /v1/runs?runbook=…` | Recent runs | read |
| `GET /v1/runs/last-green?runbook=…` | "Last ran green by X at T", verified or not | read |
| `POST /v1/alerts` | Alertmanager's webhook | alerts, when set |
| `GET /v1/alerts/recent` | Recent alerts and their runbook links | read |
| `POST /v1/devices` | A phone that gets firing alerts as pushes | devices |
| `DELETE /v1/devices/<id>` | That phone no longer | devices |
| `GET /v1/server-info`, `GET /healthz` | What it serves (`capabilities`), and whether it is up | none |

Each part is on when its main setting is there: publishing with `LIBRARY_DIR`, run summaries
with `RUNS_DIR`, alerts with `ALERT_MAP`, pushes with `PUSH_FCM_SERVICE_ACCOUNT_FILE` and/or
`PUSH_APNS_KEY_FILE`.

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
   `LIBRARY_ALLOWED_SIGNERS` (`403` otherwise):
   - OpenSSH's `allowed_signers` format, namespace `md-runbook`;
   - checked with `ssh-keygen -Y verify`, as md-runbook-gate checks it;
   - by default the `allowed_signers` file in the library folder, the same file the app offers
     its users to trust.
2. **The whole runbook is signed** ([manifest version 2](../../docs/features/signed-runbooks.md#what-is-signed))
   and nothing changed since signing (outputs, notes and ticked boxes don't count). A runbook
   signed before version 2 has only its bash blocks signed. It is refused unless
   `LIBRARY_ACCEPT_V1=true`, and then taken only with its blocks as signed (`422`).
3. **Not expired** (`422`).
4. **Named as its file.** The whole signed name is the end of the path in the library, part by
   part, without `.md`:
   - `ops/restart-api` fits `ops/restart-api.md` and `team/ops/restart-api.runbook.md`, not
     `restart-api.md` or `staging/restart-api.md`;
   - `restart-api` fits any `restart-api.md`;
   - the app checks the same before it opens one (`422`).
5. **A higher version** than any ever published at that path, even if that file was deleted
   since (`409`). Sending the same text again answers `200` with `"unchanged": true`.
6. **A plain path** (`400` otherwise):
   - relative;
   - no `..`, `.` or empty parts;
   - no hidden files or folders (`.git`);
   - at most 4 folders deep;
   - letters, digits, spaces and `. _ -` in names;
   - a Markdown file (`*.md`, so `*.runbook.md` too);
   - folders are made as needed; a path through a symbolic link is refused (`409`).
7. **At most `LIBRARY_MAX_BYTES`** (512 KiB by default, `413`).

The file is written atomically: a temporary file next to it, then a rename. So the web app serves
the old text or the new one, never half of it.

Then `index.json` is written again, with:

- every runbook in the folder, with its title;
- `signedOnly`, from `LIBRARY_SIGNED_ONLY` (on by default: the app then opens only runbooks it
  can verify).

A `folder` set by hand for a runbook in `index.json` is kept. Each publish logs the token's name,
the path, the signed name, the version before and after, and the signer.

Run one server per library folder: it serializes its own writes, not another process's.

## Run summaries

Clients send the summary of every run to the address in a runbook's `report-runs:` front matter
([run reports](../../docs/features/run-reports.md)). Point it at
`https://runbooks.example.net/v1/runs`. md-runbook-gate sends its own with `report_to` in
`gate.conf` ([signed runbooks](../../docs/features/signed-runbooks.md#run-reports-from-the-gate)).

- **Strict.** A summary must pass both checks (`400` otherwise, with the problems):
  - format version 1, with no field the format doesn't list (`runSummaryProblems`), so it can't
    carry an output or a value;
  - its totals and `green` agree with its steps.
- **Signed summaries** (the envelope `{summary, signature, signer?}`) are checked against
  `RUNS_ALLOWED_RUNNERS` (allowed_signers format, namespace `md-runbook-run`) with ssh-keygen.
- **Kept append-only**, one JSON line per summary in `RUNS_DIR/runs-YYYY-MM.jsonl`. Each line
  has:
  - when it arrived, from which address and with which token;
  - the summary;
  - the signature as sent (to check again with `md-runbook verify-run`);
  - how far it can be believed:

  | `trust` | Meaning |
  | --- | --- |
  | `runner-signed` | A key in the allowed runners signed it (`runner` names it). |
  | `gate` | Client `gate`, sent with a gate token: md-runbook-gate's own record of what it ran. `gateMode` says the gate's mode: `separated`, or `shared` (also when the gate sent none). |
  | `unverified` | Anything else: what the sender says (`why` says why it isn't verified). |

- `RUNS_REQUIRE_SIGNED=true` refuses `unverified` summaries (`403`).
- With gate tokens set, a summary that says `client: "gate"` is refused without a gate token.
  So a client can't pass itself off as a gate.
- **Give every gate its own token.** A gate in separated mode (`cells_accounts =`) gets its token
  in `RUNS_SEPARATED_GATE_TOKENS`, any other gate in `RUNS_GATE_TOKENS`.
  - The token decides the mode, not the summary: a shared gate's blocks can read its token.
  - `gate_mode: "separated"` with a token of `RUNS_GATE_TOKENS` is refused (`400`). So a token
    in the wrong list shows in the gate's log.
  - A token in both lists stops the server at start.

`GET /v1/runs?runbook=ops/restart-api&limit=50` lists the newest runs of a runbook, newest first:

- `runbook=` is a signed name, or a path in the library. A path (`ops/restart-api.md`) matches
  the file name clients send and the signed name a gate sends.
- Without `runbook=`, every runbook.

`GET /v1/runs/last-green?runbook=…` answers the newest green run, and when that one is not
verified, the newest verified one too:

```json
{ "runbook": "ops/restart-api.md", "last": { … }, "lastVerified": { … },
  "text": "ops/restart-api.md: last ran green by bob at 2026-11-14T09:02:00.000Z (version 7), unverified; last verified green run by ana@example.net at 2026-11-14T09:01:00.000Z (version 7), verified: signed by the runner" }
```

A gate's run reads `verified: sent by a gate (separated)` or `(shared account)`.

When the library's copy says `report-runs-required: separated`:
- only a green run a gate sent in separated mode counts as `lastVerified`;
- the answer has `"required": "separated"`;
- the text says when there is none.

It applies to every `runbook=` whose runs include that copy's, in any case: `prod/deploy.md`,
`deploy`, `x/deploy.md`, `prod/deploy.markdown`. When the library can't be read, or has more than
500 runbooks, the server can't tell. Then only a separated gate's run counts, and
`"requiredUnknown"` says why.

More in [run reports](../../docs/features/run-reports.md#a-gate-in-separated-mode).

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

`ALERT_MAP` is a JSON file of routes, tried in order. The first whose `alertname` and `matchers`
match takes the alert. Matchers use Alertmanager's syntax: `=`, `!=`, `=~`, `!~`, regular
expressions anchored, RE2.

[alert-map.example.json](alert-map.example.json):

```json
{ "routes": [
  { "alertname": "KubePodCrashLooping", "matchers": ["namespace=~\"prod-.*\""],
    "runbook": "k8s/crashloop.md", "host": "{{ $labels.cluster }}",
    "params": { "NAMESPACE": "{{ $labels.namespace }}", "POD": "{{ $labels.pod }}" },
    "alertLabels": ["namespace", "pod"] }
] }
```

Templates take `{{ $labels.NAME }}` and `{{ $annotations.NAME }}`. Every link also gets these,
which a run's summary then carries
([which alert a run answered](../../docs/features/run-reports.md#which-alert-a-run-answered)):

- `ALERT` (the alert's name), `ALERT_FINGERPRINT` and `ALERT_STARTS_AT`;
- with `alertLabels`, `ALERT_LABELS` (`name=value,…`).

JSON only: YAML would be the image's one more dependency. `kill -HUP` reads the map again (a
broken one keeps the old map; the log says why).

Each alert is recorded, append-only, in `ALERTS_DIR/alerts-YYYY-MM.jsonl` (default
`STATE_DIR/alerts`), with its runbook and the link that opens it:

```
https://runbooks.example.net/open?url=https%3A%2F%2Frunbooks.example.net%2Frunbooks%2Fk8s%2Fcrashloop.md&sha256=…&host=prod-eu-1&p.NAMESPACE=prod-eu&p.POD=api-7f9&p.ALERT=KubePodCrashLooping&p.ALERT_FINGERPRINT=5f3c9e&p.ALERT_STARTS_AT=…
```

- `sha256` pins the runbook's text as it is in the library now (`LIBRARY_DIR`); the app refuses
  another text.
- A host that isn't a host name is left out.
- Alerts no route takes are recorded too, without a link, so you can see which alerts have no
  runbook yet. `GET /v1/alerts/recent` (`limit=`, `alertname=`) lists them.
- A link only opens a runbook and fills in its parameters. It never runs anything, and a signed
  runbook's parameter patterns still apply.

### Push to phones

Off until you set a sender. Then each firing alert that has a link goes to the registered
phones. What to set up in Firebase and at Apple:
[docs/push-and-testflight.md](../../docs/push-and-testflight.md).

- **Android:** Firebase Cloud Messaging, HTTP v1 (`PUSH_FCM_SERVICE_ACCOUNT_FILE`: the service
  account key file).
- **iPhone:** APNs with a `.p8` key (`PUSH_APNS_KEY_FILE`, `PUSH_APNS_KEY_ID`,
  `PUSH_APNS_TEAM_ID`).
- **Phones register** in the app: Hosts & settings → Team library → Alerts on this phone, with a
  devices token. That is `POST /v1/devices`:

  ```sh
  curl -sS -X POST -H "Authorization: Bearer $DEVICES_TOKEN" \
    -d '{"platform":"android","token":"<FCM token>","alertnames":["KubePodCrashLooping"]}' \
    https://runbooks.example.net/v1/devices
  ```

  - `alertnames`, `runbooks` (paths, or folders ending in `/`): only those alerts. Absent: all.
  - The answer is the device's `id`. `DELETE /v1/devices/<id>` with the same token removes the
    device.
  - Only that token can register the phone again (another accepted token gets `409`), so no one
    else can mute or remove it. Once that token is withdrawn, another one may.
  - Give each person their own `DEVICES_TOKENS` entry. Without `DEVICES_TOKENS`, phones use the
    read tokens: everyone who shares one of those shares its phones too.
  - The same label is the same person. To rotate a token, add the new one under the old label
    (`alice:NEW`), then withdraw the old one. Meanwhile either may update or remove the phones.
  - A phone kept without a token digest (by a pre-release of 0.27.0) gets no pushes. The first
    accepted token that registers it again holds it from then on.
- **A push says** "ALERTNAME firing" and the runbook's path, and carries the alert's link
  (`/open?url=…&sha256=…`). Nothing else: no other labels, no annotations, no tokens. Google or
  Apple sees what a push carries.
- **A tap** opens the link in the app, under the same checks as any link (its hash, the
  library's rules). It never runs anything.
- **Gone phones:** tokens the provider reports as gone (FCM `UNREGISTERED`, APNs 410) are removed.
  So are tokens it refuses 3 pushes in a row (APNs `BadDeviceToken`) while other phones get them.
- **One token, at most `PUSH_MAX_DEVICES_PER_TOKEN` phones:** one token's holder can't fill the
  list with made-up phones.
- **Repeats:** the same alert (fingerprint) is pushed again only after `PUSH_REPEAT_SECONDS`.
- **Withdrawn tokens:** a phone gets pushes only while the token it registered with is still
  accepted. Take a token out of `DEVICES_TOKENS` and its phones stop, even when a new token gets
  its label.
- Pushes go out after the webhook is answered. A failure is logged and never loses the alert.
- Devices are kept in `STATE_DIR/devices.json` (mode 600).

## Run it

Behind a reverse proxy that terminates TLS, on the web app's name.
[compose.example.yml](compose.example.yml) runs the web app, this server and Caddy, with
[Caddyfile.example](Caddyfile.example). Caddy sends:

- `/v1/library/`, `/v1/runs`, `/v1/alerts` and `/v1/devices` here;
- everything else to the web app.

Caddy doesn't send `/v1/server-info` here: on the web app's own name that path is the relay's.
The web app asks it to find one. The relay ([apps/relay](../relay/README.md)) keeps its own name.

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
| `RUNS_GATE_TOKENS` | | Tokens of md-runbook-gate in shared mode (`report_token_file`), one per gate. |
| `RUNS_SEPARATED_GATE_TOKENS` | | Tokens of gates in separated mode, one per gate. Only these may send `gate_mode: "separated"`. |
| `RUNS_READ_TOKENS` | none: reading is off | Tokens that may read runs (and alerts, unless `ALERTS_READ_TOKENS`). |
| `RUNS_ALLOWED_RUNNERS` | | The runners' keys (namespace `md-runbook-run`). |
| `RUNS_REQUIRE_SIGNED` | `false` | Refuse summaries that no known runner signed and no gate sent. |
| `RUNS_MAX_BYTES` | `65536` | Largest summary. |
| `ALERT_MAP` | | The alert map (JSON). Turns alerts on. |
| `PUBLIC_URL` | required with `ALERT_MAP` | The web app's public address, `https://…`: links are `PUBLIC_URL/open?…`. |
| `LIBRARY_PUBLIC_PATH` | `/runbooks/` | Where the web app serves the library on that address. |
| `ALERTS_TOKENS` | required with `ALERT_MAP` | Tokens Alertmanager sends (`http_config.authorization`). |
| `ALERTS_ALLOW_ANYONE` | `false` | `true`: take alerts without a token. Only where nobody else can reach `/v1/alerts`: a forged alert can point on-call at another host. |
| `ALERTS_READ_TOKENS` | `RUNS_READ_TOKENS` | Tokens that may read alerts. |
| `ALERTS_DIR` | `STATE_DIR/alerts` | Where alerts are kept. |
| `ALERTS_MAX_BYTES` | `1048576` | Largest webhook. |
| `PUSH_FCM_SERVICE_ACCOUNT_FILE` | | Firebase service account key (JSON). Turns pushes to Android on. Needs `ALERT_MAP`. |
| `PUSH_APNS_KEY_FILE` | | APNs key (`AuthKey_XXXXXXXXXX.p8`). Turns pushes to iPhones on. Needs `ALERT_MAP`. |
| `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID` | required with `PUSH_APNS_KEY_FILE` | The key's 10-character ID, and your team's. |
| `PUSH_APNS_TOPIC` | `dev.mdrunbook.app` | The app's bundle ID. |
| `PUSH_APNS_SANDBOX` | `false` | `true` for development builds (Xcode, debug): APNs' sandbox. TestFlight and App Store builds use production. |
| `DEVICES_TOKENS` | `ALERTS_READ_TOKENS` | Tokens a phone registers with. |
| `PUSH_MAX_DEVICES` | `1000` | Most phones kept. |
| `PUSH_MAX_DEVICES_PER_TOKEN` | `50` | Most phones one devices token may register. |
| `PUSH_REPEAT_SECONDS` | `3600` | The same alert is pushed again only after this long. |
| `STATE_DIR` | `./data` (`/data` in the image) | The highest version published per path, and alerts. |
| `SERVER_HOST`, `SERVER_PORT` | `127.0.0.1`, `8090` | Where it listens (the image: `0.0.0.0`). |
| `TRUST_PROXY` | `false` | The client address is the last `X-Forwarded-For` entry. Only behind your own proxy. |
| `CORS_ORIGINS` | none | Pages on other origins allowed to read answers in a browser. Same origin needs none. |
| `RATE_PER_MINUTE` | `120` | Requests per client address per minute to `/v1/`. |
| `MAX_FAILURES`, `FAIL_WINDOW_SECONDS` | `10`, `600` | Failed token checks per client address before it is refused for the window. |
| `SSH_KEYGEN` | `ssh-keygen` | OpenSSH's ssh-keygen, 8.2 or newer. |

- Every token list also takes `NAME_FILE` (Docker secrets).
- A token is at least 24 characters (`openssl rand -hex 32`).
- `label:token` gives a token a name in the log (`ci:3f9a…`). Otherwise it is logged by a short
  hash of itself.
- Invalid settings stop the server at start (exit 2).

## Security

- **What each token allows.**
  - *Upload:* publish runbooks that pass every check above, and delete them where that is on.
    It can't put an unsigned or altered runbook in, or replace a version with an older one.
    That takes a signer's key, which the server never holds.
  - *Runs:* send summaries.
  - *Gate:* send summaries too, and only it can send `client: "gate"` ones, which count as
    verified.
    - A gate token sits on each gated server, readable by the account the gate runs as. So
      whoever can run commands there can send a summary in the gate's name.
    - In shared mode that includes the blocks the gate runs. Only a token of
      `RUNS_SEPARATED_GATE_TOKENS` can send a separated gate's summary.
    - One token per server, so it can be withdrawn alone.
  - *Read:* read runs and alerts (names, times, results, alert labels; no outputs).
  - *Alerts:* send alerts, which the server only records and turns into links.
  - *Devices:* register a phone for firing alerts, and remove one (by its id). That is as much
    as reading alerts, so it defaults to the read tokens. Give phones their own with
    `DEVICES_TOKENS`, so a phone's token can't read the alert history.
- **Tokens** travel only in `Authorization: Bearer`, never in URLs. They are compared in constant
  time against every token, and never logged (only their names). Clients that fail the check too
  often are refused for a while.
- **Signatures** are checked with OpenSSH's ssh-keygen, as md-runbook-gate and the command line
  check them. So every key type works the same everywhere: Ed25519, ECDSA, RSA and FIDO (`sk-`)
  keys. So do allowed_signers options such as `valid-before`.
- The namespaces keep a runbook signature (`md-runbook`) and a run summary's (`md-runbook-run`)
  apart.
- **The library folder** is written only by this server, only below `LIBRARY_DIR`, and
  atomically. It is never written through a symbolic link, and never as a hidden file. The web
  container mounts it read-only.
- **Limits:** body sizes, requests per client per minute, 30 seconds per request.
- **The container** runs as `node` (uid 1000), with all capabilities dropped. Its root is
  read-only, with `/tmp` as tmpfs (for ssh-keygen's temporary files). It needs no outbound network,
  except with pushes: `oauth2.googleapis.com` and `fcm.googleapis.com` (Android),
  `api.push.apple.com` or `api.sandbox.push.apple.com` (iPhone), all on 443.
- **Push keys** (the service account and the `.p8` key) can only send pushes to this app. Keep them
  as Docker secrets; the server never logs them, nor the phones' push tokens.
- **What it can't do:** prove that the steps of a summary really ran as it says. A runner's
  signature proves which key sent it. The gate's log is the record of what ran on a gated server.
- **What it stores:** run summaries (who ran what, when, and how it ended) and alert labels. Who
  may read them, and for how long they are kept, is your policy. The files are append-only, one
  per month, to archive or delete as you decide.

## Tests

`npm test` builds the server and runs its tests with real ssh-keygen keys and signatures. The push
tests send to fake FCM and APNs servers on the machine (HTTP and HTTP/2), never to Google or
Apple. The
[Library server workflow](../../.github/workflows/library-server.yml) also builds the image from
the repository root, starts it read-only and probes it from outside.

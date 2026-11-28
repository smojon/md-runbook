# Relay pairing: an ops host that only dials out (design)

Goal: an ops host with no inbound port.

- A connector next to sshd dials out to our own relay.
- Clients reach that sshd through the relay.
- SSH stays end to end.

This is "option B" of [outbound-only ops hosts](../features/ops-outbound.md): no vendor, our relay.

## Parts

- **Relay** (`apps/relay`): v1 mode (`RELAY_TARGETS`) and pairing mode (`RELAY_CONNECTORS_FILE`)
  in one process. Either or both.
- **Connector** (`md-runbook-relay-connect`, Go): keeps a control WebSocket open to each relay.
  Per session it dials sshd, then opens one data WebSocket.
- **Clients**: `md-runbook relay-connect` (an ssh `ProxyCommand`), the VS Code extension, the app.

## Wire protocol

- `wss://` only. `ws://` only to `localhost` or `127.0.0.1`, for tests.
- Tokens travel as the subprotocol `token.<token>`, never in a URL.
  [Caddyfile.example](../../apps/relay/Caddyfile.example) already redacts that header.
- `GET /v1/server-info` keeps `"protocol":1`. Older apps treat a higher number as too new.
- A relay in pairing mode adds `pair.v1`: `"capabilities":["ssh","pair.v1"]`. Clients check it.

### Control socket: `/v1/connector?name=NAME`

- Subprotocols `mdrb-connector.v1` and `token.<connector token>`.
- Text frames of JSON only, 4 KiB at most. A larger frame closes with 1009.
- A binary frame, or text that isn't a JSON object with a string `t`, closes with 1008.
- Either side ignores a message with an unknown `t`. New messages need no new version.

Messages:

| From | Message | When |
|---|---|---|
| relay | `{"t":"hello","relay":"r1","ping":30}` | Once registered. `relay`: its `RELAY_ID`. `ping`: its ping interval in seconds. |
| relay | `{"t":"session","id":"…","client":"203.0.113.5"}` | Per client. `client`: the address the relay saw, a claim for logs. |
| connector | `{"t":"refuse","id":"…","why":"busy"}` | It won't take that session. `why`: `busy` or `sshd`. The client gets 503. |

- A session id is 128 random bits in base64url: 22 characters.
- A refusal counts only from the connector the session went to.

### Data socket: `/v1/connector/accept?id=ID`

- Per session the connector dials sshd (`127.0.0.1:2222`) first. Then it opens this socket.
- Subprotocols `mdrb-connector.v1` and the token of the control socket that got the session.
- The relay accepts an id once, within 10 s, and only with that token.
- One WebSocket per session: TCP's flow control per session, no multiplexing.
- Unknown id, or another token's: 404, and the id stays usable. A client that left or waited too
  long: 410.

### Client socket: `/v1/connect?name=NAME`

- Subprotocols `mdrb-relay.v1` and `token.<client token>`.
- Checks in this order: path, failure lockout, Origin, protocol, token kind and scope, name,
  caps.
- A name matches `^[a-z0-9][a-z0-9-]{0,62}$`.
- The relay holds the client's upgrade until the connector's data socket arrives. It then
  upgrades both and splices them. So each failure is plain HTTP, before any SSH byte.
- A held upgrade counts against the caps, as an open session does.

### Status codes

| Status | Where | Meaning |
|---|---|---|
| 400 | all | A URL, name, id, subprotocol or handshake the relay can't use. |
| 401 | all | An unknown token, or one of another kind. Counts as a failed check. |
| 403 | all | The Origin; a name outside the token's scope; a connector outside its ranges. |
| 404 | all | A path that is off (pairing mode not set); an unknown session id. |
| 410 | accept | The client left, or waited 10 s. |
| 429 | all | The failure lockout, or a cap. A full name of connectors adds `Retry-After`. |
| 503 | connect | No connector, or it refused the session, or it went away. |
| 504 | connect | No data socket within 10 s. |

### Origin

The new endpoints accept a request with no Origin, with the relay's own, or with one in
`RELAY_ORIGINS`.

- The relay's own origin: `https://` and the request's Host. `http://` too for a local Host.
- A browser always sends Origin. So a page elsewhere can't use a token it holds, even with
  `RELAY_ORIGINS` empty.
- `/v1/ssh` keeps its rule: any origin while `RELAY_ORIGINS` is empty.

### Splice

- Binary frames pass unchanged, each at most 257 KiB, both ways. That is one SSH packet.
- The connector reads sshd in 32 KiB chunks.
- Backpressure: one side's queue at 1 MiB pauses reading the other side. It resumes as the queue
  drains.
- A text frame on a data or client socket ends the session.
- One side closes: the other gets close 1000 after what is still queued. An error gives 1011.
- `RELAY_MAX_SESSION_SECONDS` applies. Both sides then get 1000, cut 1 s later.

### Keepalive and close codes

- The relay pings every socket each `RELAY_PING_SECONDS`: client, control and data. A missed
  pong cuts that socket.
- The connector pings every 30 s. It reconnects after silence of 2 × `ping` + 10 s.
- Close codes, RFC 6455 section 7.4.1: 1000 normal, 1001 going away, 1008 policy, 1009 too big,
  1011 error.
- Codes 4000 to 4999 are private (section 7.4.2). None is used yet.

### Reconnecting

- Backoff from 1 s, doubling to 60 s, with full jitter. It resets after 60 s connected.
- 401, 403 or 404: wait 5 minutes and log loudly. Ten failures in 10 minutes lock an address out.
  Behind a cluster's NAT, that would lock out its clients too.
- 429: `Retry-After`, else 60 s. A close with 1001: 1 to 5 s, with jitter.

### More than one

- Up to `RELAY_MAX_CONNECTORS_PER_NAME` connectors per name, 2 by default, for rollouts.
- New sessions go to the oldest live connector. A second one logs `connector-duplicate`.
- Two ops pods behind one name don't work: a stop request must reach the pod that runs the cell.
  Two pods need two names.
- Two relays: the connector gets `MDRB_RELAY_URLS=wss://r1,wss://r2`. It runs one control loop
  per relay.
- Clients try the relays in order. The next one comes on a network error, a timeout or any HTTP
  refusal.
- When all fail, a client reports each relay's error. It never retries once SSH bytes flowed.

## Auth

Three kinds of token:

| Kind | Where | Opens |
|---|---|---|
| connector | `RELAY_CONNECTORS_FILE`: lines `name token [cidr,…]` | `/v1/connector*`, for its name only, from its ranges if given. |
| client | `RELAY_CLIENTS_FILE`: lines `token name,name` or `token *` | `/v1/connect`, for those names. |
| v1 | `RELAY_TOKEN`, `RELAY_TOKENS`, `RELAY_TOKEN_FILE` | `/v1/ssh`, and `/v1/connect` for every name. |

- A token of another kind gets 401 and counts as a failed check.
- A connector token starts with `mdrbc-`; no other token may. The relay checks both at start.
- A token twice, in any kinds or files: the relay won't start.
- Every token: at least 24 RFC 7230 token characters. The relay compares SHA-256 digests, with
  every entry, in constant time.

Why connectors need their own tokens: a connector receives other people's sessions. With a client
token, one could register as the ops host. That allows:

- denial of service and traffic analysis;
- the first host key a TOFU client sees;
- a full MITM of clients that ignore host keys, secret values sent to cells included.

A pinned host key protects credentials and stops replay. It doesn't stop the rest.

Storage:

- Kubernetes: Secret `md-runbook-ops-relay`, key `token`. Mounted read-only, mode 0440, in the
  connector's container only, at `/etc/md-runbook-relay/token`.
- Never an inline environment variable: the cells' ClusterRole reads pod specs.
- Relay: the files as Docker secrets.

### Limits and logs

- One failure map for all endpoints, keyed as in v1. An IPv6 /64 counts as one client.
- `RELAY_MAX_PER_CLIENT` and `RELAY_MAX_CONNECTIONS` count client sessions, held ones too.
- `RELAY_MAX_PER_NAME` caps client sessions per name, 32 by default.
- Control sockets count per name, not per address: a cluster's connectors may share one.
- New events: `connector-up` and `connector-down` (name, token name, source, why), and
  `connector-duplicate`.
- `open` and `close` gain `mode: "pair"`, the name, the session and the connector's address.
- The session is its id's first 8 characters. Never a token, a whole id or data.

## The connector

- A Go binary in the gate's module, with a minimal WebSocket client of its own. No dependency;
  its frame reader is fuzzed.
- Kubernetes: a second container `relay-connect` in the ops pod, same image. A patch adds it:
  `apps/ops/kubernetes/relay-connector.yaml`.
- Not inside the `ops` container: the session cleanup spares only sshd's process tree.
- The pod stops automounting the service-account token. Only the `ops` container mounts it.
- The connector listens on nothing. Under Compose it runs as a service with `network_mode: service:ops`.
- Per session it binds a source address `127.h1.h2.h3` on Linux: 24 bits of a hash of the
  client's key.
- sshd's `PerSourcePenalties` and `PerSourceMaxStartups` then count per client, not per relay.
- A sessions file passes the client's address to the gate. The gate logs it as `relay_client`: a
  claim, never used for decisions.
- Outbound only: the ops Service may go. An egress rule allows the relays' fixed IPs, TCP 443.

## Threat model

New risks, and what limits them:

| Risk | Mitigation |
|---|---|
| The relay is compromised. | It sees ciphertext and metadata only. It can deny service, or offer a new host key: clients pin keys. Two relays; break-glass with `kubectl port-forward`; host keys come with pairing. |
| A connector token is stolen. | It serves one name. Sessions go to the oldest connector. `connector-duplicate` alerts. A CIDR pin; revoke its line in the relay's file. |
| A client token is stolen. | It reaches sshd's pre-auth surface, nothing more. Scoped names, caps, lockout, 127.x penalties. An SSH key is still required. |
| Denial of service on the relay. | Two relays; port-forward; a manual, IP-restricted Service. |
| Someone takes a name. | The operator binds each name to its tokens. |
| Replay. | TLS only. Ids are random, 128 bits, single-use, valid 10 s, bound to name and token. |
| One source address locks all out. | The 127.x source spreading. |
| Trust on first use. | Host keys in pairing; the fingerprint in `kubectl logs`. Never `StrictHostKeyChecking no`. |
| The egress rule to IP:443. | Fixed addresses, documented. It is a small exfiltration path for the ops container too. |
| A forged client address. | Parsed as an IP address, logged only. |
| Malformed frames. | Size caps; fuzzing on the Go side. |

Unchanged: SSH end to end, every gate check, `authorized_keys` and certificates, the host key pin.
Only the logged client address changes meaning. In relay mode sshd sees 127.x, and so does
`from=` in `authorized_keys`.

# md-runbook relay

The md-runbook web app runs runbook cells on your servers over SSH. A browser cannot open SSH
(TCP) connections itself, so the web app opens a WebSocket to this relay, and the relay copies
the bytes to one of your SSH servers.

SSH runs in the browser. The relay only ever sees encrypted SSH traffic. It does see which
address connects to which server, and when, and that is all it logs. The phone apps connect
directly and need no relay.

## What keeps it from being an open proxy

- **Allowlist.** It only connects to the `host:port` pairs in `RELAY_TARGETS`.
- **Token.** Each connection needs a token of at least 24 characters. The token travels as a
  WebSocket subprotocol, so it never appears in URLs or access logs.
- **Origins.** With `RELAY_ORIGINS` set, only pages from those origins may connect.
- **Limits.** Connections are capped in total and per client address. An address that fails the
  token check 10 times in 10 minutes is refused for the rest of that window.

## Run it

Behind a reverse proxy that terminates TLS, so the web app reaches it as `wss://`.
[compose.example.yml](compose.example.yml) does this with Caddy, which gets the certificate:

```sh
cd apps/relay
openssl rand -base64 32 > relay-token.txt
# Edit compose.example.yml (targets, origins) and Caddyfile.example (your relay's name).
docker compose -f compose.example.yml up -d
```

Then, in the web app, open Hosts and set the relay address (`wss://relay.example.net`) and the
token. Before connecting, the app asks the relay which protocol it speaks. If the two don't
match, the app says which one to update.

Without Docker, with Node 22:

```sh
npm ci && npm run build
RELAY_TOKEN=… RELAY_TARGETS=web1.example.net:22 npm start
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | required | The token clients send. At least 24 characters. |
| `RELAY_TOKENS` | | More tokens, comma-separated, for example one per person. |
| `RELAY_TOKEN_FILE` | | A file with tokens, one per line, for Docker secrets. |
| `RELAY_TARGETS` | required | `host:port` pairs, comma-separated. `*:22` allows any host on port 22. |
| `RELAY_ORIGINS` | any | Page origins allowed to connect, such as `https://runbooks.example.net`. |
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. The container uses `0.0.0.0`. |
| `RELAY_PORT` | `8022` | Port to listen on. |
| `RELAY_MAX_CONNECTIONS` | `50` | Open connections in total. |
| `RELAY_MAX_PER_CLIENT` | `8` | Open connections per client address. |
| `RELAY_MAX_FAILURES` | `10` | Failed token checks per client address per window. |
| `RELAY_FAIL_WINDOW_SECONDS` | `600` | The window for failed token checks. |
| `RELAY_TRUST_PROXY` | off | `1`: the client address is the last `X-Forwarded-For` entry. Only behind your own proxy. |
| `RELAY_CONNECT_TIMEOUT_SECONDS` | `10` | Time to reach an SSH server. |
| `RELAY_PING_SECONDS` | `30` | Ping interval. A browser that misses one ping is disconnected. |

## Protocol

Version 1:

- `GET /v1/server-info` answers `{"name":"md-runbook-relay","protocol":1,"version":"…","capabilities":["ssh"]}`.
- `GET /healthz` answers `ok`.
- The WebSocket is `/v1/ssh?target=host:port`, with the subprotocols `mdrb-relay.v1` and
  `token.<token>`. Binary frames carry the SSH bytes.

A future protocol gets a new path and subprotocol, and the relay keeps serving the old one for a
while. Update the relay before the app.

Each log line is JSON: `open` and `close` events with the client address, the target, the bytes
each way and the duration, plus `refused` events with the reason.

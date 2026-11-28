# md-runbook relay

The md-runbook web app runs runbook cells on your servers over SSH. A browser cannot open SSH
(TCP) connections itself, so the web app opens a WebSocket to this relay. The relay copies the
bytes to one of your SSH servers.

SSH runs in the browser. The relay only ever sees encrypted SSH traffic. It does see which
address connects to which server, and when, and that is all it logs.

The phone apps connect directly and need no relay.

## What keeps it from being an open proxy

- **Allowlist.** It only connects to the `host:port` pairs in `RELAY_TARGETS`.
- **Token.** Each connection needs a token of at least 24 characters. The token travels as a
  WebSocket subprotocol, so it never appears in URLs.
  - [Caddyfile.example](Caddyfile.example) writes it as `REDACTED` in Caddy's access log.
  - Caddy's global `debug` option logs the header elsewhere, unfiltered: leave it off.
- **Origins.** With `RELAY_ORIGINS` set, only pages from those origins may connect.
- **Limits.** Connections are capped in total and per client address. An address that fails the
  token check 10 times in 10 minutes is refused for the rest of that window.
  - An IPv6 address counts by its /64, so a client can't change address to get round the limits.
  - A whole /64 is then one client, as an office behind one IPv4 address is. A shared network
    may need a higher `RELAY_MAX_PER_CLIENT`.
  - One old token used there 10 times locks the whole /64 out for the window.
  - An IPv6 address that holds an IPv4 address counts as that address: `::ffff:192.0.2.1`,
    `::ffff:0:192.0.2.1`, `::192.0.2.1` and `64:ff9b::192.0.2.1` (NAT64).
  - The relay remembers failed checks of at most 10,000 clients. When full, expired ones go
    first, then the oldest.
- **Session lifetime.** A session ends after 24 hours by default, however busy it is. A leaked
  token's session can't last for ever.

## Run it

Behind a reverse proxy that terminates TLS, so the web app reaches it as `wss://`.
[compose.example.yml](compose.example.yml) does this with Caddy, which gets the certificate:

```sh
cd apps/relay
openssl rand -hex 32 > relay-token.txt
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

The relay must be able to reach your SSH servers. For servers on a private network, run it on
a machine inside that network.

### On an Oracle Cloud Always Free VM

For SSH servers that are reachable from the internet, a free VM is enough. The relay needs very
little: one CPU and 1 GB of memory.

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com).
   - Signing up asks for a card, but Always Free resources are not charged. They exist only in
     your home region, which you choose at sign-up.
   - Upgrading the account to Pay As You Go keeps them free and stops Oracle from reclaiming
     instances it considers idle. An idle relay counts as idle.
2. **Compute → Instances → Create instance:** image Ubuntu 24.04, shape `VM.Standard.A1.Flex`
   (1 OCPU, 6 GB). If that shape is "out of capacity", use `VM.Standard.E2.1.Micro`. Add your
   SSH public key and keep **Assign a public IPv4 address**.
3. **Networking → Virtual cloud networks →** the instance's subnet **→ Security list → Add
   ingress rules:** source `0.0.0.0/0`, TCP, destination ports `80,443`. Caddy needs port 80 for
   its certificate.
4. Point a DNS name at the instance's public IP: an `A` record such as
   `relay.example.net`.
5. On the VM (`ssh ubuntu@<public-ip>`):

   ```sh
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
   git clone https://github.com/smojon/md-runbook && cd md-runbook/apps/relay
   openssl rand -hex 32 > relay-token.txt
   cp Caddyfile.example Caddyfile
   sed 's|./Caddyfile.example|./Caddyfile|' compose.example.yml > compose.yml
   # compose.yml: RELAY_TARGETS (your servers) and RELAY_ORIGINS (the web app's origin).
   # Caddyfile: relay.example.net → your relay's name.
   sudo docker compose up -d
   curl https://relay.example.net/v1/server-info
   ```

   If the `curl` times out from outside, the image's own firewall is refusing the ports. Open
   them:
   `sudo iptables -I INPUT 5 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save`.
6. On your SSH servers, allow SSH from the VM's public IP. That is the address the relay connects
   from.

To update the relay: `git pull && sudo docker compose up -d --build`. Git ignores your
`compose.yml`, `Caddyfile` and `relay-token.txt`.

## Pairing mode

In pairing mode an ops host needs no inbound port:

1. A connector next to its sshd dials out to the relay and waits.
2. A client asks the relay for the ops host by name.
3. The relay pairs the two WebSockets.

- SSH still runs end to end: the relay sees encrypted SSH traffic only.
- Pairing mode and `RELAY_TARGETS` work side by side. With connectors set, `RELAY_TARGETS` is
  optional.
- The design and the wire protocol: [docs/design/relay-pairing.md](../../docs/design/relay-pairing.md).

### Tokens

Pairing mode adds two files, one line per token. Lines starting with `#` and empty lines don't
count.

`RELAY_CONNECTORS_FILE`: the connectors, as `name token [ranges]`.

```text
# name   token                                     ranges (optional)
prod-eu  mdrbc-replace-me-with-openssl-rand-hex-32   203.0.113.0/24,2001:db8:5::/48
staging  mdrbc-another-one-for-staging-replace-me
```

- A connector token registers only its own name. With ranges, only from those source addresses.
- A connector token must start with `mdrbc-`. No other token may.
- A name: lowercase letters, digits and `-`, up to 63 characters, not starting with `-`.
- A name may have several lines, for example to rotate its token.

`RELAY_CLIENTS_FILE`: the clients, as `token names`.

```text
# token                                   names
replace-me-alice-openssl-rand-hex-32     prod-eu,staging
replace-me-on-call-team-token-hex-32     *
```

- `*` allows every name.
- Tokens from `RELAY_TOKEN`, `RELAY_TOKENS` and `RELAY_TOKEN_FILE` count as client tokens for
  every name, too.
- A client token on a connector's endpoint gets 401. So does a connector token on a client's.
  Both count as failed checks.

Rules for every token, checked at start:

- at least 24 characters, letters and digits (`openssl rand -hex 32`; prefix `mdrbc-` for a
  connector);
- the same token in two places stops the relay. Only the v1 variables may repeat a token, as
  before.

Make a connector token with `printf 'mdrbc-%s\n' "$(openssl rand -hex 32)"`.

### Limits

- `RELAY_MAX_CONNECTIONS` and `RELAY_MAX_PER_CLIENT` count client sessions of both modes.
  A client waiting for its connector counts too.
- `RELAY_MAX_PER_NAME` caps the client sessions of one name.
- `RELAY_MAX_CONNECTORS_PER_NAME` caps the connectors of one name: 2 by default, for a rollout.
- New sessions go to the oldest connector of a name. A second one logs `connector-duplicate`.
- Connectors count per name, not per address: a cluster's connectors may share one address.

A client waits at most 10 s for the connector. It gets an HTTP answer before any SSH byte:

| Status | Meaning |
|---|---|
| 503 | No connector for that name, or it refused the session, or it went away. |
| 504 | The connector didn't answer within 10 s. |

### With Docker Compose

Keep both files next to `compose.example.yml`, as Docker secrets. Git ignores
`relay-connectors.txt` and `relay-clients.txt`.

```yaml
services:
  relay:
    environment:
      RELAY_TOKEN_FILE: /run/secrets/relay_token
      RELAY_CONNECTORS_FILE: /run/secrets/relay_connectors
      RELAY_CLIENTS_FILE: /run/secrets/relay_clients
    secrets: [relay_token, relay_connectors, relay_clients]

secrets:
  relay_token:
    file: ./relay-token.txt
  relay_connectors:
    file: ./relay-connectors.txt
  relay_clients:
    file: ./relay-clients.txt
```

The relay runs as user `node`: each file must be readable by it. To revoke a token, remove its
line and restart the relay.

### Logs in pairing mode

- `connector-up` and `connector-down`: the name, the token's name, the connector's address, and
  why it went.
- `connector-duplicate`: a second connector of a name, with both addresses.
- `left`: a client that went before its connector answered.
- `open` and `close` gain `"mode":"pair"`, the name, the session and the connector's address.
- The session is the first 8 characters of its id. The relay never logs a token or a whole id.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | required | The token clients send. At least 24 characters, letters and digits (`openssl rand -hex 32`): the browser sends it in a header, so base64's `/` and `=` are refused. In pairing mode, `RELAY_CLIENTS_FILE` may replace it. |
| `RELAY_TOKENS` | | More tokens, comma-separated, for example one per person. |
| `RELAY_TOKEN_FILE` | | A file with tokens, one per line, for Docker secrets. |
| `RELAY_TARGETS` | required | `host:port` pairs, comma-separated. `*:22` allows any public host on port 22; a server on the relay itself or a private network (127.x, 10.x, 192.168.x, …) must be listed by name or address. Optional with `RELAY_CONNECTORS_FILE`. |
| `RELAY_CONNECTORS_FILE` | | Pairing mode: the connectors' names, tokens and source ranges (see [Pairing mode](#pairing-mode)). |
| `RELAY_CLIENTS_FILE` | | Pairing mode: client tokens and the names each may reach. Needs `RELAY_CONNECTORS_FILE`. |
| `RELAY_MAX_PER_NAME` | `32` | Client sessions per connector name, waiting ones included, 1 or more. |
| `RELAY_MAX_CONNECTORS_PER_NAME` | `2` | Connectors per name, 1 or more. |
| `RELAY_ID` | the host name | The relay's name in its `hello` to connectors, for their logs. |
| `RELAY_ORIGINS` | any | Page origins allowed to connect, such as `https://runbooks.example.net`. |
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. The container uses `0.0.0.0`. |
| `RELAY_PORT` | `8022` | Port to listen on, 0 to 65535. 0: a port the system picks. |
| `RELAY_MAX_CONNECTIONS` | `50` | Open connections in total, 1 or more. |
| `RELAY_MAX_PER_CLIENT` | `8` | Open connections per client address (IPv6: per /64), 1 or more. |
| `RELAY_MAX_FAILURES` | `10` | Failed token checks per client address per window, 1 or more. |
| `RELAY_FAIL_WINDOW_SECONDS` | `600` | The window for failed token checks, 0 or more. 0: failed checks are not counted. |
| `RELAY_TRUST_PROXY` | off | `1`: the client address is the last `X-Forwarded-For` entry. Only behind your own proxy. |
| `RELAY_CONNECT_TIMEOUT_SECONDS` | `10` | Time to reach an SSH server, 0 to 2147483. 0: the system's own timeout. |
| `RELAY_PING_SECONDS` | `30` | Ping interval, 1 to 2147483. A browser that misses one ping is disconnected at once. |
| `RELAY_MAX_SESSION_SECONDS` | `86400` | A session's longest life, 60 to 2147483. The next cell opens a new session, and the app warns that earlier folders and variables are gone. |

A setting that is not a whole number, or is out of range, stops the relay at start. The ranges
refuse only values that broke the relay:

- a cap of 0 refused every connection;
- a ping every 0 seconds closed every session;
- a timer over 2147483 seconds (24.8 days) went off after 1 ms.

## Protocol

Version 1:

- `GET /v1/server-info` answers `{"name":"md-runbook-relay","protocol":1,"version":"…","capabilities":["ssh"]}`.
- `GET /healthz` answers `ok`.
- The WebSocket is `/v1/ssh?target=host:port`, with the subprotocols `mdrb-relay.v1` and
  `token.<token>`. Binary frames carry the SSH bytes.
- A frame from the browser holds at most 257 KiB: one SSH packet. OpenSSH refuses a packet
  over 256 KiB anyway. A larger frame closes the session (code 1009).
- In pairing mode the capabilities are `["ssh","pair.v1"]`, and three more WebSockets exist:
  `/v1/connect`, `/v1/connector` and `/v1/connector/accept`. The protocol number stays 1.

A future protocol gets a new path and subprotocol, and the relay keeps serving the old one for a
while. Update the relay before the app.

Each log line is JSON:

- `open` and `close` events, with the client address, the target, the bytes each way and the
  duration;
- `refused` events, with the reason.

Events after the token check also name the token: `token-` and the first 8 hex digits of its
SHA-256. Find a token's name with `printf %s "$TOKEN" | sha256sum | cut -c1-8`. The token
itself is never logged.

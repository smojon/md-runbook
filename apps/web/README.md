# md-runbook web app, as a container

The web app behind nginx, for hosting it yourself. It is apps/mobile's web export, the same
build GitHub Pages serves. Host it next to your relay and ops host, inside a company network, or
in a lab.

```sh
docker build -t md-runbook-web -f apps/web/Dockerfile .     # from the repository root
docker run --rm -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp md-runbook-web
```

Released with md-runbook as `ghcr.io/smojon/md-runbook-web:VERSION`, for amd64 and arm64.

- **A domain of its own**: the app keeps its SSH key and stored secrets in the origin's
  localStorage. Any other page served from the same origin could read them, so serve nothing
  else there. The relay on the same origin, under `/v1/`, is fine: it is part of the app.
- **TLS** is your reverse proxy's job; the container speaks HTTP on port 8080 as a non-root user.
- **Runbook links** work as on Pages: `https://<your domain>/open?url=…&host=…` opens the runbook
  in the app ([runbook links](../../docs/switching.md#runbook-links)). The browser downloads the
  runbook, so its server must allow your origin (CORS), or serve it from the same origin.
- The relay ([apps/relay](../relay/README.md)) is what lets the web app run cells over SSH.
- The library server ([apps/library-server](../library-server/README.md)) is on the same origin,
  under `/v1/library/`, `/v1/runs` and `/v1/alerts`. It publishes signed runbooks into the team
  library, collects run summaries and turns alerts into runbook links. It too is part of the app.

## Settings

Two environment variables. When the container starts, they are written to `/config.json`, which
the app reads when it loads.

The file is in `/tmp`, so the container stays read-only. It holds nothing secret: anyone who can
reach the web app can read it, and it never holds a token.

| Variable | Default | What it does |
|---|---|---|
| `MD_RUNBOOK_PUBLIC_URL` | none: the address the page was opened from | The address users reach the web app at, such as `https://runbooks.example.net` or a tunnel's `https://….trycloudflare.com`. Share links, QR codes (Show QR Code, Share library) and pairing links start with it. `https` only (`http` only for `localhost`), with no query, fragment or `user@`. Users can override it under Hosts & settings → **Public address of this web app**. |
| `MD_RUNBOOK_LIBRARY` | `/runbooks/` | The team library's folder on the web app's own address. With `/sop/`, the app lists the runbooks at `https://<your domain>/sop/`, and the container serves the folder mounted at `/usr/share/nginx/html/sop` with the library's rules ([below](#a-team-library)). A folder path: `/name/` or `/name/sub/`, no `..`, no hidden folders, and none of the app's own paths (`/_expo/`, `/assets/`, `/runbook/`, `/hosts/`). |

An invalid value stops the container with a message saying why, rather than handing out links
that lead nowhere. `/config.json` then looks like this:

```json
{"publicUrl":"https://runbooks.example.net","library":"/sop/"}
```

Without the file (GitHub Pages, the development server), the app uses the page's own address and
`/runbooks/`.

A compose file with the web app, its library in `./sop` and the relay on the same address. A
reverse proxy (Caddy here, or a tunnel) sends `/v1/` to the relay and the rest to the web app.

The web app then fills in the relay's address by itself ("this server's relay"). Users only enter
the token, or pair their phone (Hosts & settings → Relay → **Pair a device**):

```yaml
services:
  web:
    image: ghcr.io/smojon/md-runbook-web:VERSION
    restart: unless-stopped
    environment:
      MD_RUNBOOK_PUBLIC_URL: https://runbooks.example.net
      MD_RUNBOOK_LIBRARY: /sop/
    volumes:
      - ./sop:/usr/share/nginx/html/sop:ro
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    expose: ['8080']

  relay:
    image: ghcr.io/smojon/md-runbook-relay:VERSION
    restart: unless-stopped
    environment:
      RELAY_TOKEN_FILE: /run/secrets/relay_token
      RELAY_TARGETS: web1.example.net:22,web2.example.net:22
      RELAY_ORIGINS: https://runbooks.example.net
      RELAY_TRUST_PROXY: '1'
    secrets: [relay_token]
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    expose: ['8022']

  caddy:
    image: caddy:2.10.2-alpine
    restart: unless-stopped
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

secrets:
  relay_token:
    file: ./relay-token.txt   # openssl rand -hex 32 > relay-token.txt

volumes:
  caddy-data:
```

and the `Caddyfile` next to it:

```caddyfile
runbooks.example.net {
	reverse_proxy /v1/* relay:8022
	reverse_proxy web:8080
}
```

With a Cloudflare quick tunnel instead of Caddy, the tunnel's address changes on every start.
Set `MD_RUNBOOK_PUBLIC_URL` to it and restart the web container. Or set it in the app under
**Public address of this web app**.

## A team library

Put runbooks in a folder and every user of this web app sees them under **Team runbooks**, without
uploading anything. Opening one makes the user's own copy in their browser. Their runs and
outputs stay theirs, and the shared file is never changed.

When the file on the server changes, their copy offers **Update** (outputs of unchanged blocks are
kept) or **Keep mine**. The phone apps can use the same library: its address is
`https://<your domain>/runbooks/` ([the app](../../docs/app.md#team-runbooks)).

The container serves `/usr/share/nginx/html/runbooks` at `/runbooks/`, read-only, and nginx lists
each folder as JSON for the app (`autoindex_format json`). Subfolders become groups.

With `MD_RUNBOOK_LIBRARY=/sop/` ([settings](#settings)) it is `/usr/share/nginx/html/sop` at
`/sop/`, with the same rules, and the app reads the library there. Mount the folder:

```sh
docker run --rm -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp \
  -v ./runbooks:/usr/share/nginx/html/runbooks:ro md-runbook-web
```

or build it into an image of your own:

```dockerfile
FROM ghcr.io/smojon/md-runbook-web:VERSION
COPY runbooks/ /usr/share/nginx/html/runbooks/
```

The files must be readable by the container's user (`chmod -R a+rX runbooks`). Without the
folder, `/runbooks/` answers 404 and the app shows no library.

**The folder is public to anyone who can reach the web app**: every file in it is listed and
readable without logging in, as the app itself is. Put nothing there you would not hand to every
user. Keep the container inside your network if the runbooks are internal.

Hidden files and folders (`.git/`, `.env`, `.draft.md`) answer 404 even when asked for by name.
Symbolic links to files of another owner (a link to `/etc/passwd`) are refused
(`disable_symlinks if_not_owner`). But a git checkout's other files, backups (`deploy.md~`) and
anything else are served.

```
runbooks/
├── index.json          optional: names, titles, folders, signedOnly
├── allowed_signers     optional: the signers users can choose to trust
├── restart-api.md
└── databases/
    └── restore.md      listed under "Team runbooks · databases"
```

- **index.json** (optional) lists the runbooks instead of the folder listing: the app reads it
  first. Titles default to the runbook's `# heading`, folders to its subfolder.

  ```json
  {
    "signedOnly": true,
    "runbooks": [
      "restart-api.md",
      { "path": "databases/restore.md", "title": "Restore a database", "folder": "Databases" }
    ]
  }
  ```

- **allowed_signers** (optional, OpenSSH's format, the same file as md-runbook-gate's):
  - The app shows its names and key fingerprints under **Trust these signers**, and asks first.
    It also shows what a pattern such as `*@example.net` lets a key sign as.
  - The app never trusts them by itself. The server vouches for itself, so whoever can change the
    runbooks can change this file too.
  - Trust counts for this library only. A key you remove from the file stops counting in the app.
  - Once trusted, a signed runbook says **Signed by alice@example.net: these steps verified**,
    with its signed name and version. Otherwise it says **Partly signed**, **Signed, unknown
    signer**, **Not signed** or **Changed since signing**
    ([signed runbooks](../../docs/features/signed-runbooks.md#in-a-hosted-library)).
  - Lines with options OpenSSH doesn't know are skipped, as OpenSSH skips them.
- **`"signedOnly": true`** in index.json: only verified runbooks open. Verified means:
  - signed by a signer the user trusts for this library;
  - no runnable block outside the signature;
  - not expired;
  - not older than a version seen before.

  The others are listed as not openable, with the reason. Once a library asked for it, the app
  keeps it on if index.json stops asking, until the user agrees.
- Files are served with `Cache-Control: no-cache`; the app reads the library on start (at most
  once a minute) and on **Refresh**. Hidden files (`.name`) are neither listed nor served. The
  app refuses a file over 2 MB and a redirect to another server.
- **Another origin:** the phone apps read the library from anywhere. A web app served from another
  domain reads it only if the library's server allows that origin (CORS:
  `add_header Access-Control-Allow-Origin https://app.example.net always;`). This container sends
  no CORS headers on purpose: no site its users visit should read a library inside your network.
- **GitHub Pages** has no folder listing, so there the library needs an index.json. The Pages
  workflow publishes `apps/mobile/public/runbooks/` when it exists (Expo copies `public/` into the
  export). When the folder has no index.json, the workflow writes one listing its `.md` files.

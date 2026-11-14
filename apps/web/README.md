# md-runbook web app, as a container

The web app (apps/mobile's web export, the same build GitHub Pages serves) behind nginx, for
hosting it yourself: next to your relay and ops host, inside a company network, or in a lab.

```sh
docker build -t md-runbook-web -f apps/web/Dockerfile .     # from the repository root
docker run --rm -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp md-runbook-web
```

Released with md-runbook as `ghcr.io/smojon/md-runbook-web:VERSION`, for amd64 and arm64.

- **A domain of its own.** The app keeps its SSH key and stored secrets in the origin's
  localStorage. Any other page served from the same origin could read them, so serve nothing
  else there. The relay on the same origin, under `/v1/`, is fine: it is part of the app.
- **TLS** is your reverse proxy's job; the container speaks HTTP on port 8080 as a non-root user.
- **Runbook links** work as on Pages: `https://<your domain>/open?url=…&host=…` opens the runbook
  in the app ([runbook links](../../docs/switching.md#runbook-links)). The runbook is downloaded
  by the browser, so its server must allow your origin (CORS), or serve it from the same origin.
- The relay ([apps/relay](../relay/README.md)) is what lets the web app run cells over SSH.

## A team library

Put runbooks in a folder and every user of this web app sees them under **Team runbooks**, without
uploading anything. Opening one makes the user's own copy in their browser: their runs and outputs
stay theirs, and the shared file is never changed. When the file on the server changes, their copy
offers **Update** (outputs of unchanged blocks are kept) or **Keep mine**. The phone apps can use the
same library: its address is `https://<your domain>/runbooks/` ([the app](../../docs/app.md#team-runbooks)).

The container serves `/usr/share/nginx/html/runbooks` at `/runbooks/`, read-only, and nginx lists
each folder as JSON for the app (`autoindex_format json`). Subfolders become groups. Mount the
folder:

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

- **allowed_signers** (optional, OpenSSH's format, the same file as md-runbook-gate's): the app
  shows its names and key fingerprints under **Trust these signers** and asks first. It never
  trusts them by itself: the server vouches for itself, so whoever can change the runbooks can
  change this file too. Once trusted, a signed runbook says **Signed by alice@example.net,
  verified**; otherwise **Signed, unknown signer**, **Not signed** or **Changed since signing**
  ([signed runbooks](../../docs/features/signed-runbooks.md#in-a-hosted-library)).
- **`"signedOnly": true`** in index.json: unsigned runbooks, and runbooks changed since signing,
  are listed as not openable, with the reason.
- Files are served with `Cache-Control: no-cache`; the app reads the library on start (at most
  once a minute) and on **Refresh**. Hidden files (`.name`) are not listed.
- **Another origin:** the phone apps read the library from anywhere. A web app served from another
  domain reads it only if the library's server allows that origin (CORS:
  `add_header Access-Control-Allow-Origin https://app.example.net always;`). This container sends
  no CORS headers on purpose: a library inside your network should not be readable by any site its
  users visit.
- **GitHub Pages** has no folder listing, so there the library needs an index.json. The Pages
  workflow publishes `apps/mobile/public/runbooks/` when it exists (Expo copies `public/` into the
  export) and writes an index.json listing its `.md` files when the folder has none.

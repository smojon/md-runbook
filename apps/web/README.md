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

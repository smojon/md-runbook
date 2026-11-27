# The md-runbook web app as a container: the app's static web export (apps/mobile, the same
# build GitHub Pages serves) behind nginx, to host it yourself. Plain HTTP only on localhost:
# elsewhere put https in front (the app makes no SSH key on a plain-HTTP page). Give it a domain
# of its own: the relay token and other secrets sit in the origin's localStorage, which any other
# page served from the same origin could read (new SSH keys are WebCrypto keys the browser won't
# export, in IndexedDB). README.md.
#
#   docker build -t md-runbook-web -f apps/web/Dockerfile .
#
# The build context is the repository root: the app uses packages/core and packages/ssh from
# their sources.

# Both images by the digest of their multi-arch index: a rebuild gets the bytes we tested, not
# whatever the tag names that day. Releases at least 7 days old. By hand:
# `docker buildx imagetools inspect IMAGE:TAG`, its Digest line.

# The export is JavaScript, the same for every platform: built once, on the build machine's own.
# Node 22.23.5 (2026-11-11, a security release).
FROM --platform=$BUILDPLATFORM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src/apps/mobile
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/core/src /src/packages/core/src
COPY packages/ssh/src /src/packages/ssh/src
COPY apps/mobile/ ./
RUN npx expo export --platform web

# nginx's stable line, 1.30.7 (2026-11-18: the try_files with alias fix, CVE-2026-125283).
# From 1.30.7 on, the unprivileged image is nginx/nginx-unprivileged; nginxinc/ stopped at 1.30.6.
FROM nginx/nginx-unprivileged:1.30.7-alpine@sha256:0c53a1f2890c3526bfd201440f0fd3970e5b78f80630f58284aad0d34b5ec7bd
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/library.conf /etc/nginx/md-runbook-library.conf
# Run by nginx's entrypoint before nginx starts: /config.json from MD_RUNBOOK_PUBLIC_URL and
# MD_RUNBOOK_LIBRARY, written to /tmp (the container runs read-only).
COPY --chmod=0755 apps/web/40-md-runbook-config.sh /docker-entrypoint.d/40-md-runbook-config.sh
COPY --from=build /src/apps/mobile/dist /usr/share/nginx/html
# A team library: a runbooks/ folder at /usr/share/nginx/html/runbooks, mounted read-only
# (-v ./runbooks:/usr/share/nginx/html/runbooks:ro) or copied into an image built on this one.
# With MD_RUNBOOK_LIBRARY=/sop/, the folder at /usr/share/nginx/html/sop.
EXPOSE 8080

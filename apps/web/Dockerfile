# The md-runbook web app as a container: the app's static web export (apps/mobile, the same
# build GitHub Pages serves) behind nginx, to host it yourself. Give it a domain of its own:
# the app keeps its SSH key in the origin's localStorage, which any other page served from the
# same origin could read. README.md.
#
#   docker build -t md-runbook-web -f apps/web/Dockerfile .
#
# The build context is the repository root: the app uses packages/core and packages/ssh from
# their sources.

# The export is JavaScript, the same for every platform: built once, on the build machine's own.
FROM --platform=$BUILDPLATFORM node:22.23.1-alpine AS build
WORKDIR /src/apps/mobile
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/core/src /src/packages/core/src
COPY packages/ssh/src /src/packages/ssh/src
COPY apps/mobile/ ./
RUN npx expo export --platform web

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/mobile/dist /usr/share/nginx/html
# A team library: a runbooks/ folder at /usr/share/nginx/html/runbooks, mounted read-only
# (-v ./runbooks:/usr/share/nginx/html/runbooks:ro) or copied into an image built on this one.
EXPOSE 8080

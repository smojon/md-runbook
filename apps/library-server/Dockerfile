# The md-runbook library server as a container. Settings come from the environment (README.md);
# TLS is your reverse proxy's job (see compose.example.yml).
#
#   docker build -t md-runbook-library-server -f apps/library-server/Dockerfile .
#
# The build context is the repository root: the server is built with packages/core's sources.

FROM node:22.23.1-alpine AS build
WORKDIR /src/apps/library-server
COPY apps/library-server/package.json apps/library-server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/core/src /src/packages/core/src
COPY apps/library-server/tsconfig.json ./
COPY apps/library-server/src ./src
COPY apps/library-server/test ./test
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22.23.1-alpine
# Runbook and runner signatures are checked with OpenSSH's ssh-keygen, as md-runbook-gate does.
RUN apk add --no-cache openssh-keygen && mkdir -p /data /library && chown node:node /data /library
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8090 \
    STATE_DIR=/data
WORKDIR /app
COPY --from=build /src/apps/library-server/package.json ./
COPY --from=build /src/apps/library-server/node_modules ./node_modules
COPY --from=build /src/apps/library-server/dist/apps/library-server/src ./dist/apps/library-server/src
COPY --from=build /src/apps/library-server/dist/packages ./dist/packages
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/apps/library-server/src/main.js"]

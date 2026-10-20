# The md-runbook relay as a container. Settings come from the environment (README.md); TLS is
# your reverse proxy's job (see compose.example.yml with Caddy).
#
#   docker build -t md-runbook-relay apps/relay
#   docker run --rm -p 127.0.0.1:8022:8022 -e RELAY_TOKEN=… -e RELAY_TARGETS=web1:22 md-runbook-relay

FROM node:22.23.1-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22.23.1-alpine
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8022
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist/src ./dist/src
USER node
EXPOSE 8022
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8022)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]

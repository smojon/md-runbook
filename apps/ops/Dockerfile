# md-runbook ops host: an SSH server whose only command is md-runbook-gate, with kubectl. The
# md-runbook app connects to it as to any host; runbooks reach your clusters from here, so no
# cluster credential is ever on a phone. See README.md.
#
#   docker build -t md-runbook-ops -f apps/ops/Dockerfile apps
#
# The build context is apps/ (the gate's Go source is in apps/gate).

# md-runbook-gate from source, as a release builds it (scripts/ci/build-gate.sh): static, without
# file paths or a build ID, with the Go toolchain go.mod names, which must be this image's (the
# build stops otherwise). Built on the build machine for the target platform, without emulation.
FROM --platform=$BUILDPLATFORM golang:1.27.3-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS gate
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY gate/go.mod gate/go.sum* ./
RUN want=$(sed -n "s/^toolchain //p" go.mod) \
 && if [ "$want" != "$(go env GOVERSION)" ]; then \
      echo "go.mod names toolchain $want, this image has $(go env GOVERSION): update the golang image" >&2; exit 1; \
    fi \
 && go mod download
COPY gate/ ./
RUN GOOS="${TARGETOS:-linux}" GOARCH="${TARGETARCH:-amd64}" \
    go build -trimpath -ldflags="-s -w -buildid=" -o /md-runbook-gate ./cmd/md-runbook-gate

# Debian 13 slim, both stages, by the digest of its multi-arch index: a rebuild gets the bytes we
# tested, not whatever the tag names that day. A point release at least 7 days old (13.8 came out
# 2026-11-24). Dependabot (.github/dependabot.yml, 7-day cooldown) proposes new ones. By hand:
# `docker buildx imagetools inspect debian:13.N-slim`, its Digest line, in both FROMs.
#
# kubectl, checked against SHA-256s written down here, not against a .sha256 fetched from the
# host the binary comes from (one compromised host could change both). 1.35: kubectl works within
# one minor version of the cluster, so with 1.34 to 1.36. For another version, change all three:
#   curl -fsSL https://dl.k8s.io/release/VERSION/bin/linux/ARCH/kubectl.sha256
# The release builds amd64 and arm64 (release.yml); another architecture stops the build.
FROM debian:13.7-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS kubectl
ARG KUBECTL_VERSION=v1.35.10
ARG KUBECTL_SHA256_AMD64=c49a28f1f4efc4d475ed05f47f2ce8e563bf7bef69ed77fe1b924ea6d83b6327
ARG KUBECTL_SHA256_ARM64=283f1be6a46b3695b625e25030106b8ffe18bd0d3a900f5b65c259ca407f04f5
ARG TARGETARCH
RUN arch="${TARGETARCH:-amd64}" \
 && case "$arch" in \
      amd64) sum="$KUBECTL_SHA256_AMD64" ;; \
      arm64) sum="$KUBECTL_SHA256_ARM64" ;; \
      *) echo "no kubectl SHA-256 for $arch: add a KUBECTL_SHA256_ build argument" >&2; exit 1 ;; \
    esac \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSLo /kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && echo "$sum  /kubectl" | sha256sum -c - \
 && chmod 755 /kubectl

FROM debian:13.7-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
# openssh-client: ssh-keygen (-Y checks signatures in the gate; start.sh makes the host key).
# The gate is a static binary and needs nothing else. (procps comes with openssh-server.)
# For runbooks: curl, jq, and what md-runbook-probe uses (openssl, ping, dig).
# The account's login shell is /bin/sh (dash): sshd starts the gate with it, and bash would run
# ~/.bashrc, a file the account can write, before the gate. Blocks still run in bash.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server openssh-client bash tini ca-certificates curl jq \
      openssl iputils-ping bind9-dnsutils netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && useradd --uid 10001 --user-group --create-home --shell /bin/sh ops \
 && install -d -m 755 /etc/md-runbook /etc/md-runbook-ops \
 && install -d -o ops -g ops -m 700 /run/md-runbook-ops /var/lib/md-runbook-ops /var/log/md-runbook
# kubectl in /usr/bin: md-runbook-gate runs its programs only from root's system folders.
COPY --from=kubectl /kubectl /usr/bin/kubectl
COPY --from=gate /md-runbook-gate /usr/local/bin/md-runbook-gate
COPY ops/sshd_config /etc/ssh/md-runbook-ops.conf
COPY ops/gate.conf /etc/md-runbook/gate.conf
COPY ops/start.sh /usr/local/bin/md-runbook-ops-start
COPY ops/md-runbook-probe /usr/local/bin/md-runbook-probe
RUN chmod 755 /usr/local/bin/md-runbook-gate /usr/local/bin/md-runbook-ops-start /usr/local/bin/md-runbook-probe \
 && touch /etc/md-runbook/allowed_signers \
 && chmod 644 /etc/ssh/md-runbook-ops.conf /etc/md-runbook/gate.conf /etc/md-runbook/allowed_signers

# Non-root: sshd can only log in as the account it runs as (ops), which is all it needs.
USER 10001:10001
ENV HOME=/home/ops
WORKDIR /home/ops
EXPOSE 2222
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/2222 && head -c 4 <&3 | grep -q SSH-'
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/md-runbook-ops-start"]

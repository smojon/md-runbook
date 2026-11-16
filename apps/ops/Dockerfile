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
FROM --platform=$BUILDPLATFORM golang:1.26.2-trixie@sha256:4a7137ea573f79c86ae451ff05817ed762ef5597fcf732259e97abeb3108d873 AS gate
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

FROM debian:13.1-slim AS kubectl
ARG KUBECTL_VERSION=v1.34.1
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="${TARGETARCH:-amd64}" \
 && url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSLo /kubectl "$url" \
 && echo "$(curl -fsSL "$url.sha256")  /kubectl" | sha256sum -c - \
 && chmod 755 /kubectl

FROM debian:13.1-slim
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
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
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

# md-runbook-probe alone: endpoint and certificate checks from where the container runs, e.g. as a
# Pod next to the services it watches. No sshd, no gate, no kubectl. See README.md.
#
#   docker build -t md-runbook-probe -f apps/probe/Dockerfile apps
#
# The build context is apps/ (the probe script is in apps/ops, shared with the ops host).

# Debian 13 slim by the digest of its multi-arch index, like apps/ops/Dockerfile: a rebuild gets
# the bytes we tested. Dependabot (.github/dependabot.yml) proposes new ones. By hand:
# `docker buildx imagetools inspect debian:13.N-slim` (a point release at least 7 days old), its Digest line.
FROM debian:13.7-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
# The base image has bash, coreutils (timeout, date), getent and logger. The probe needs openssl
# and the CAs, and ping for --ping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates iputils-ping \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin probe
COPY ops/md-runbook-probe /usr/local/bin/md-runbook-probe
RUN chmod 755 /usr/local/bin/md-runbook-probe

# No /etc/md-runbook/gate.conf: the audit events go where MD_RUNBOOK_PROBE_LOG says (README.md).
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/md-runbook-probe"]
CMD ["--help"]

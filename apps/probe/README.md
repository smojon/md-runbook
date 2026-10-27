# md-runbook-probe image

md-runbook-probe on its own, as a small container image: the endpoint and certificate checks of
the [ops host](../ops/README.md#md-runbook-probe), without sshd, md-runbook-gate or kubectl.
Run it as a Pod next to the services it watches, to see them as they see each other: a loop that
publishes the checks as Prometheus metrics, and `kubectl exec` for a check by hand.

- **The probe is the entrypoint**: `docker run --rm ghcr.io/smojon/md-runbook-probe:latest
  api.example.net db.internal:5432`.
- **Non-root** (uid 10001), and it writes no files of its own, so a read-only root filesystem
  works.
- **Only what the probe uses**: bash, coreutils, openssl, the CA certificates and ping (for
  `--ping`), on the same Debian base as the ops host.
- **No gate.conf**: the audit events go where `MD_RUNBOOK_PROBE_LOG` says (below).

## Options and formats

The options are the probe's (`md-runbook-probe --help`), described in
[docs/features/kubernetes.md](../../docs/features/kubernetes.md#is-everything-up-endpoint-and-certificate-checks).
For a Pod, these matter most:

- `--format prometheus` prints the metrics `md_runbook_probe_ok`, `md_runbook_probe_reachable`,
  `md_runbook_probe_certificate_expiry_timestamp_seconds` (TLS targets with a certificate) and
  `md_runbook_probe_last_run_timestamp_seconds`, each with `target="host:port"`.
  `--format json` prints one JSON object per target and line.
- `--label NAME=VALUE` adds a label to every metric and JSON object, e.g. `--label
  component=proxy`. One run has one set of labels.
- `tls://host:port` checks TLS on any port, `tcp://host:port` only opens a TCP connection.
- `--ca FILE` trusts that CA in addition to the system's CAs, `--ca-only FILE` trusts it alone.

## In a cluster

[kubernetes/md-runbook-probe.yaml](kubernetes/md-runbook-probe.yaml) sets up:
- the namespace `md-runbook-probe`, with Pod Security `restricted` enforced;
- a ConfigMap with the targets, one per line;
- a Deployment: the probe in a loop every 60 s with `--format prometheus`, writing to a shared
  in-memory folder, and a busybox sidecar that serves it on port 9100 as `/metrics.prom`. No
  service account token, a read-only root filesystem, no capabilities;
- a Service on port 9100 for Prometheus.

```sh
kubectl apply -f apps/probe/kubernetes/md-runbook-probe.yaml
ns="-n md-runbook-probe"
kubectl $ns edit configmap md-runbook-probe-targets          # your targets
kubectl $ns port-forward service/md-runbook-probe 9100 &
curl -s localhost:9100/metrics.prom
```

Prometheus scrapes it with `metrics_path: /metrics.prom` (a scrape config or a ServiceMonitor).
An alert on certificates that expire within 14 days:

```yaml
- alert: CertificateExpiresSoon
  expr: md_runbook_probe_certificate_expiry_timestamp_seconds - time() < 14 * 86400
```

To label targets differently (`component="proxy"` for some, `component="idm"` for others), run
one probe per label set, each with its own file and scrape path, or add the label in Prometheus
from `target` with `metric_relabel_configs`. Two runs' outputs can't simply be concatenated: a
metric's lines must be together, with one `# HELP` and `# TYPE`.

## Checks by hand, and the audit trail

```sh
kubectl -n md-runbook-probe exec deploy/md-runbook-probe -c probe -- md-runbook-probe tls://proxy.my-app.svc:8443
kubectl -n md-runbook-probe logs deploy/md-runbook-probe -c probe       # the probe events
```

The manifest sets `MD_RUNBOOK_PROBE_LOG=/proc/1/fd/1`: in a container, that is the output of
its first process, so each check made with `kubectl exec` is a `probe` event in the container's
log, which `md-runbook audit` reads like the gate's log (`kubectl logs … > probe.log`, then
`md-runbook audit probe.log`). Outside the gate, `MD_RUNBOOK_PROBE_LOG` takes a file, `stderr`
or `syslog`; without it nothing is logged. When the destination can't be written (a read-only
filesystem, no syslog), the probe says so once on stderr. On the ops host, the gate runs the
probe and `gate.conf` alone decides where its events go.

These events say less than the ops host's: without the gate there is no signed run and no SSH
key, only the account and the time. Who may `kubectl exec` into the Pod is up to your RBAC.

## Build it

```sh
docker build -t md-runbook-probe -f apps/probe/Dockerfile apps
```

The build context is `apps/`, because the probe script is in `apps/ops`. Each md-runbook release
publishes the image as `ghcr.io/smojon/md-runbook-probe`, next to the ops host. The
[Ops host workflow](../../.github/workflows/ops.yml) tests it with docker and in a kind cluster.

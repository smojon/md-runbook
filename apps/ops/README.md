# md-runbook ops host

A small SSH server for running runbooks against your clusters from the md-runbook app. It is
an ordinary host in the app, but every login goes to md-runbook-gate, and `kubectl` is
installed. Cluster credentials stay on this host and never reach a phone. The guide is
[docs/features/kubernetes.md](../../docs/features/kubernetes.md).

- **sshd** runs as the account `ops` (uid 10001), not as root, on port 2222. It accepts keys
  only: no passwords, no forwarding, no terminal.
- **md-runbook-gate** is the only command
  ([apps/gate](../gate/README.md)). It runs signed runbooks, and unsigned cells only where
  `gate.conf` allows them. It logs every request, and its log is printed to the container's
  output.
- **kubectl** logs in with the Pod's service account inside a cluster, or with a kubeconfig you
  mount outside one. The kubeconfig's context name is what runbooks write as `kube-context:`.
- **md-runbook-probe** checks endpoints from where the host runs (below).
- Also installed for runbooks: `curl`, `jq`, `openssl`, `dig`, `ping` and `nc`.

## Files it reads

All of these are read-only mounts:

| Path | What | Without it |
| --- | --- | --- |
| `/etc/md-runbook-ops/keys/authorized_keys` | Public keys allowed to log in: the app's key from **Hosts & settings → This app's SSH key**, one line per phone | nobody can log in |
| `/etc/md-runbook-ops/hostkey/ssh_host_ecdsa_key` | The server's host key, which the app pins | one is made at first start (kept in `/var/lib/md-runbook-ops`) |
| `/etc/md-runbook/gate.conf`, `/etc/md-runbook/allowed_signers` | The gate's policy and the publishers' keys | signed runbooks only, and no publishers yet |
| `/etc/md-runbook-ops/kubeconfig/config` | kubectl's login outside a cluster | inside a cluster: the Pod's service account |

**Install my key…** in the app doesn't work here, because there are no passwords. Put the
app's public key into `authorized_keys` yourself.

## In a cluster

[kubernetes/md-runbook-ops.yaml](kubernetes/md-runbook-ops.yaml) sets up:
- the namespace `md-runbook-ops`, with Pod Security `restricted` enforced;
- a service account and a ClusterRole for what runbooks may do. They may read everything
  except Secrets, run `rollout restart` and `rollout undo`, scale, create Jobs from CronJobs,
  and read cert-manager certificates. They may not delete anything or exec into pods;
- the gate's ConfigMap, the Deployment and a ClusterIP Service on port 22.

```sh
kubectl apply -f apps/ops/kubernetes/md-runbook-ops.yaml
ns="-n md-runbook-ops"
# The app's public key (one line per phone):
kubectl $ns create configmap md-runbook-ops-keys --from-file=authorized_keys
# A host key that survives restarts (else the app reports a changed key after each one).
# ECDSA P-256: the app's SSH library doesn't accept Ed25519 host keys.
ssh-keygen -q -t ecdsa -b 256 -N '' -C md-runbook-ops -f ssh_host_ecdsa_key
kubectl $ns create secret generic md-runbook-ops-hostkey --from-file=ssh_host_ecdsa_key
# The cluster's name as runbooks will say it (kube-context: prod-eu):
kubectl $ns set env deployment/md-runbook-ops CLUSTER_NAME=prod-eu
# Your publishers, and the policy (edit, then apply):
kubectl $ns edit configmap md-runbook-ops-gate
kubectl $ns rollout restart deployment/md-runbook-ops
kubectl $ns logs deployment/md-runbook-ops | grep 'host key'   # the fingerprint the app shows
```

**Reaching it from a phone.** The Service only works inside the cluster. You have three
options:
- **A LoadBalancer.** `kubectl $ns patch service md-runbook-ops -p '{"spec":{"type":"LoadBalancer","loadBalancerSourceRanges":["203.0.113.0/24"]}}'`
  exposes it; limit the source ranges to your own addresses.
- **A VPN** into the cluster's network.
- **The relay in the cluster**, for the web app ([apps/relay](../relay/README.md), with
  `RELAY_TARGETS=md-runbook-ops.md-runbook-ops.svc:22`).

**More rights.** Add rules to the ClusterRole, or bind the service account to a narrower Role per
namespace instead. Whatever the role allows, every runbook on this host can do.

## Next to the relay

The relay's [compose.example.yml](../relay/compose.example.yml) has an `ops` service:

```sh
cd apps/relay
cp -r ../ops/example ops        # keys/, gate/, kubeconfig/: fill them in
docker compose --profile ops up -d
```

Phones connect to port 2222 of that machine. The web app goes through the relay: add
`ops:2222` to `RELAY_TARGETS`. Outside a cluster, kubectl needs a kubeconfig in
`ops/kubeconfig/config`. Use a service account token with the rights above, not your own login.
The cloud logins of EKS, GKE and AKS need their own CLIs, which this image doesn't have, so that
is one more reason to run the host inside the cluster.

## md-runbook-probe

```sh
md-runbook-probe api.example.net db.internal:5432 https://shop.example.net/health
kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' | md-runbook-probe -
md-runbook-probe --ca /var/run/secrets/kubernetes.io/serviceaccount/ca.crt kubernetes.default.svc
```

For each target, the probe:
1. looks up the name in DNS;
2. opens a TCP connection;
3. on TLS ports (443, 6443, 8443 and the like, with `--tls`, or for `tls://host:port`), checks
   the certificate: it must be trusted, be for that name, and not expire within `--days`
   (default 14). `--ca FILE` trusts that CA in addition to the system's CAs, `--ca-only FILE`
   trusts it alone.

It prints one line per target, and its exit code is 1 when any check failed, so a cell fails
on it. `--ping` also pings. ICMP is often blocked, and a container may not be allowed to send
it, in which case the line says so. `--format json` and `--format prometheus` print the same
checks for other programs, with labels from `--label NAME=VALUE` or per target
(`tls://web:8443 component=proxy`) ([all options](../../docs/features/kubernetes.md#options)).

To run only the probe, e.g. as a Pod next to your services, use the
[probe image](../probe/README.md): no sshd, no gate, no kubectl.

What keeps it as safe as the rest:
- **It runs only as a cell**, through the gate: signed runbooks only, unless `gate.conf` allows
  unsigned cells. A target is a host name, an IP address or a URL, and nothing else gets
  through: no option for openssl or ping, no spaces, no shell characters.
- **It writes an audit event for every check** to the gate's log, which is also the container's
  output. Each event records the key, the client, the signed run that started the check, the
  target, its address, the result, and the certificate's expiry and SHA-256 fingerprint.
  `md-runbook audit` lists these events under Endpoint checks. Here `gate.conf` alone decides
  where they go; `MD_RUNBOOK_PROBE_LOG` only applies where no gate runs the probe.
- **Export Report shows the checks** of a run record (an incident or a drill) in an Endpoint
  checks table: when each check ran, which endpoint, up or not, and when its certificate
  expires. The JSON export has the same data.

## Build it

```sh
docker build -t md-runbook-ops -f apps/ops/Dockerfile apps
```

The build context is `apps/`, because the image includes the gate from `apps/gate`.
`KUBECTL_VERSION` (a build argument) picks kubectl, and the build checks the download against
its published SHA-256. Each md-runbook release publishes the image as
`ghcr.io/smojon/md-runbook-ops`. The [Ops host workflow](../../.github/workflows/ops.yml) tests
it in a kind cluster and outside one.

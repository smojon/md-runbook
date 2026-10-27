# Kubernetes

Runbooks with `kubectl` cells work as they are: in VS Code and on the command line they use your
own kubeconfig. Two things make them safer, and the app adds a third:

1. **The wrong-cluster guard.** `kube-context: prod-eu` in the front matter means no cell runs
   unless kubectl's current context is `prod-eu`.
2. **The ops host.** The app runs runbooks against your clusters through a small SSH server
   that holds the cluster access, so no cluster credential is ever on a phone.
3. **Endpoint and certificate checks** from inside the cluster, kept in the run record and in
   the audit.

## The wrong-cluster guard

```markdown
---
kube-context: prod-eu
---
```

Before each cell, `kubectl config current-context` runs where the cell would run: in the
session shell, on the app's SSH host, or through md-runbook-gate. If it doesn't print
`prod-eu`, the cell doesn't run and says why:

```text
md-runbook: this runbook is for the Kubernetes context prod-eu, and kubectl's current context is
staging-eu: nothing ran. Switch with `kubectl config use-context prod-eu`, or open the runbook
meant for staging-eu.
```

- The check runs before every cell, not once, so a `use-context` in an earlier cell or a
  colleague switching contexts mid-incident is caught.
- `kube-context=NAME` on a cell overrides the front matter for that cell. Use it in signed
  runbooks: the front matter isn't signed, but a cell's options are.
- On a server that only runs signed runbooks, the gate still answers the check: it only reads
  the kubeconfig. See the gate's `context` request in its [README](../../apps/gate/README.md).
- Lint reports a name kubectl can't have.

## The ops host

The app can't use your laptop's kubeconfig, and it shouldn't carry its own. Cloud logins (AWS
IAM for EKS, Google for GKE, Entra ID for AKS) each need their own client, and a long-lived
cluster token on a phone is the worst key to lose. Instead the app connects by SSH to the
**ops host** ([apps/ops](../../apps/ops/README.md)), and kubectl runs there.

- **Inside the cluster (recommended).** A Deployment whose service account is the only
  identity. Kubernetes rotates its token, and a ClusterRole decides what runbooks may do. The
  default role reads everything except Secrets, restarts, rolls back and scales, and doesn't
  delete. It works the same on EKS, GKE, AKS and your own clusters. Pod Security `restricted`,
  non-root, read-only root filesystem.
- **Next to the relay.** The same image as a service in the relay's compose file, with a
  kubeconfig you mount.

Either way, every login goes to md-runbook-gate. Out of the box it runs signed runbooks only,
and it logs every request. To the app, the ops host is a host like any other: add it under
**Hosts & settings**, put its name in a [host group](../app.md#hosts-and-the-apps-key) per
cluster, and pin runbooks to it with `host=`.

## Is everything up? Endpoint and certificate checks

Expired certificates and unreachable dependencies cause many outages, and they look different
from inside the cluster than from your laptop. The ops host has **md-runbook-probe**, which
checks each target in turn:
1. the name resolves in DNS;
2. a TCP connection opens;
3. on TLS ports, the certificate is trusted, is for that name, and doesn't expire within 14 days.

```bash name="Every Ingress host"
kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' |
  sort -u | md-runbook-probe -
```

```text
OK    kubernetes.default.svc:443                10.96.0.1, tcp 3ms, certificate trusted, 364 days left (2027-10-27), CN=kube-apiserver, issuer kubernetes
FAIL  shop.example.net:443                      203.0.113.9, tcp 20ms, certificate expires in 9 days (2026-11-05), under 14, CN=shop.example.net, issuer R11
FAIL  db.internal:5432                          10.0.3.4, no TCP connection within 5s (down, or a firewall)
```

A failed line fails the cell. The checks are kept and controlled like everything else on the
host:
- **Controlled.** The probe runs only as a cell, through the gate (signed runbooks only, unless
  allowed). Its targets are host names, addresses or URLs, and nothing else gets through.
- **In the record.** Export Report (HTML, PDF) lists each check of an incident or drill record
  under **Endpoint checks**: when, which step, which endpoint, up or not, and the certificate's
  expiry. The JSON export carries the same data.
- **In the audit.** Each check is a `probe` event in the gate's log. It records the key, the
  client, the signed run that made it, the address, the result, and the certificate's expiry
  and SHA-256 fingerprint. [`md-runbook audit`](for-auditors.md) lists these events.

[examples/kubernetes.runbook.md](../../examples/kubernetes.runbook.md) puts it together. It
checks the cluster, the API server, every Ingress, your own endpoints and cert-manager's
certificates, then restarts a deployment (and rolls it back if needed).

## Not there yet

- Pods aren't hosts: the app doesn't open `kubectl exec` sessions into a pod by itself. A cell
  on the ops host can run `kubectl exec` if you give the role `pods/exec`.
- The ops host image has kubectl, but not the cloud CLIs (`aws`, `gcloud`, `az`). Inside a
  cluster it doesn't need them.

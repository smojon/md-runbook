---
# Every cell runs only while kubectl's current context is this one (on the ops host: its
# CLUSTER_NAME). Change it to your cluster's.
kube-context: my-cluster
params:
  - NAMESPACE: default
  - DEPLOYMENT: web
  - ENDPOINTS: api.example.net db.internal:5432
---

# Kubernetes: is everything up, then restart a deployment

Run it from the md-runbook app on the [ops host](../docs/features/kubernetes.md), or in VS Code
with your own kubeconfig. Each cell checks the cluster first: on another context nothing runs.

## Where are we

```bash name="Cluster and nodes"
kubectl config current-context
kubectl get nodes -o wide
```

## Is everything reachable, are the certificates valid

The ops host checks from inside the cluster: the same DNS, network and trust as your workloads.
A failed line, or a certificate that expires within 14 days, fails the cell.

```bash name="API server"
md-runbook-probe --ca /var/run/secrets/kubernetes.io/serviceaccount/ca.crt kubernetes.default.svc
```

```bash name="Every Ingress host"
kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' |
  sort -u | md-runbook-probe -
```

Your own endpoints (the `ENDPOINTS` parameter): `host`, `host:port` or a URL each.

```bash name="Endpoints"
md-runbook-probe ${param:ENDPOINTS}
```

Certificates cert-manager renews (skipped where cert-manager isn't installed):

```bash name="cert-manager certificates"
if kubectl api-resources --api-group=cert-manager.io -o name | grep -q '^certificates'; then
  kubectl get certificates -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,EXPIRES:.status.notAfter,RENEWAL:.status.renewalTime'
else
  echo "cert-manager is not installed"
fi
```

## The deployment

```bash name="Status"
kubectl -n "${param:NAMESPACE}" get deployment "${param:DEPLOYMENT}" -o wide
kubectl -n "${param:NAMESPACE}" get pods -l "app=${param:DEPLOYMENT}" -o wide
kubectl -n "${param:NAMESPACE}" get events --sort-by=.lastTimestamp | tail -n 15
```

## Restart it

```bash name="Rollout restart" confirm
kubectl -n "${param:NAMESPACE}" rollout restart deployment/"${param:DEPLOYMENT}"
kubectl -n "${param:NAMESPACE}" rollout status deployment/"${param:DEPLOYMENT}" --timeout=5m
```

- [ ] The pods are Running and Ready again

## If it got worse: roll back

Run All asks before this one: say no unless the restart made things worse.

```bash name="Roll back" confirm
kubectl -n "${param:NAMESPACE}" rollout undo deployment/"${param:DEPLOYMENT}"
kubectl -n "${param:NAMESPACE}" rollout status deployment/"${param:DEPLOYMENT}" --timeout=5m
```

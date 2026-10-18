---
params:
  - NAMESPACE: shop-prod
---

# Restart the checkout service

Safe demo for screenshots: every block only prints simulated `kubectl` output, so it runs
anywhere without a cluster. See `docs/screenshots.md` for the shot list.

- [x] Announce the restart in #ops
- [ ] Check the dashboards after the rollout

## 1. Where we are

```pwsh os=windows
Write-Output "context: prod-eu-1   namespace: ${param:NAMESPACE}"
```

```bash os=linux,macos
echo "context: prod-eu-1   namespace: ${param:NAMESPACE}"
```

## 2. Find the pod

```bash capture="POD:/^(checkout-\S+)/m" expect="Running"
echo "NAME                        READY   STATUS    RESTARTS   AGE"
echo "checkout-7c9d5b6f4-x2kqp    1/1     Running   0          3d4h"
echo "payments-5d8f7c9b8-9hjtw    1/1     Running   1          3d4h"
```

## 3. Restart it, line by line

Use **Step Through Lines** (F10) here:

```bash
echo "deployment.apps/checkout restarted"
echo "Waiting for deployment \"checkout\" rollout to finish: 1 old replicas are pending termination..."
echo "pod ${out:POD} terminated"
```

## 4. Wait until it is ready

```bash retry=5 every=1s expect="successfully rolled out"
f="${TMPDIR:-/tmp}/md-runbook-shot-${PPID}"
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"
if [ "$n" -lt 3 ]; then echo "Waiting for rollout to finish: 0 of 1 updated replicas are available..."; exit 1; fi
rm -f "$f"; echo "deployment \"checkout\" successfully rolled out"
```

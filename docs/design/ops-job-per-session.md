# Ops host: each session's cells in a Job (design)

Goal: on the Kubernetes ops host, a session's blocks run in a pod and service account of their
own. They can't reach the gate's token, log or state, nor another session.

## gate.conf

- `cells_runner = kubernetes-job` turns it on. The default is `local`.
- `job_service_account = NAME`: the cells' account. Required with the runner, refused without.
- `job_image = IMAGE`: optional. Default: the ops pod's own image (container `ops`, else its only
  one), so the Job runs the same gate.
- The namespace is the ops pod's own (its kubeconfig's context): the owner reference needs it.
- Fail closed: the gate doesn't start with `cells_account`, `isolation = scope|bwrap`, outside a
  pod, or without a root-only `kubectl` in `/usr/bin` (as its other programs).

## Session start

- Before the hello, about half a second of kubectl: `config view` and `get pod HOSTNAME` (context,
  namespace, uid, image). Then the ops account's self-check, the sweep and `create -f -`.
- In the background: `get jobs,pods -l md-runbook-job=NAME` every 0.5 s until Ready, at most
  3 minutes. A bad image or a failed Job ends it at once. Then the cells' self-check in the
  pod, then the exits follower.
- Hello, `load` and `param` don't wait; the first block does, and says so on stderr. A failure
  prints the reason, logs a `job` event and ends the session (exit 2).
- Latency: about 2 to 5 s with the image on the node; a first pull adds its time.

## Cells across the pod boundary

- Each shell: `kubectl exec -i -q -n NS POD -c cells -- md-runbook-gate __cells`, with sudo's
  `exec` request. Only the transport changes. The request carries the shell's number: the cells'
  mode calls `setsid` and writes its pid to `/tmp/.md-runbook-gate-shells/N`.
- Exits: appended to `/tmp/.md-runbook-gate-exits` with the run's random number, as in separated
  mode. One more exec (`__cells follow`) streams that file to the gate, which logs `end` events.
  - It also streams the pod's `log =` file. Probe events of this session's runs are logged again
    under the gate's names.
  - A block can write into that stream. As for the exits file (M1), anything but an expected line
    ends the session, and so does the stream's early end.
- Stop requests: the gate's pid file says `job NS JOB N`. The second connection finds the pod
  and runs `__cells stop`, which signals shell N's descendants.
- A shell that ends mid-session: `__cells end`: TERM to its group and descendants, KILL a second
  later. A shell not started and sent nothing is dropped at once.
- Session end, signals: the shells finish what they were sent, then the gate deletes the Job.
  That ends everything in the pod. Kill and cleanup calls are bounded (5 s, `WaitDelay`).

## Cleanup

- `kubectl delete job NAME --wait=false` at the end (background cascade).
- Owner reference to the ops pod: its deletion deletes its Jobs.
- `activeDeadlineSeconds: 86400`, `ttlSecondsAfterFinished: 60`, `backoffLimit: 0`.
- Each session start deletes Jobs of this pod whose gate (`md-runbook-gate-pid`) is gone.

## The Job's pod

- Restricted: uid 10001, no privilege escalation, no capabilities, seccomp RuntimeDefault,
  read-only root, emptyDirs for `/home/ops`, `/tmp`, `/var/log/md-runbook`. 50m CPU and 64Mi
  requested; 512Mi and 1Gi ephemeral storage at most.
- `tini -- md-runbook-ops-start cells`: the kubeconfig of its own account (context
  `CLUSTER_NAME`, the ops pod's), then sleep. Ready once the kubeconfig is written.

## RBAC

- Ops account: a Role in its namespace: Jobs (create, get, list, watch, delete), pods (get,
  list, watch), `pods/exec` (create, get).
- Cells' account: what the ops account had before. `pods/log` moves to the per-namespace role,
  since the ops pod's output is the gate's log. Never bound in the ops namespace.

## gate_mode and the self-check

- A Job session reports `gate_mode` `separated`. The `session` event adds `cells_runner`, `job`
  and `cells`; `isolation` is `pod`. Separated mode's own checks (strays, cron) don't run.
- SelfSubjectAccessReviews, one `kubectl create -f -` for each account. A wrong answer: no
  session.
  - Ops account, at start: it must run Jobs and exec. It must not read Secrets, list pods
    everywhere, create pods, patch Deployments, mint tokens, bind roles or impersonate.
  - Cells' account, in the new pod before any block, in the ops namespace: no exec, attach, pod
    logs or Secrets. No workloads, pod or Deployment patches, or ConfigMap changes. No tokens,
    role bindings or impersonation.
- Limits: a fixed list, not every right. The ops account's bindings in other namespaces can't
  be seen without listing namespaces.

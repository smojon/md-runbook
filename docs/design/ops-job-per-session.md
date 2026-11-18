# Ops host: each session's cells in a Job (design)

Goal: on the Kubernetes ops host, a session's blocks run in a pod and service account of their
own. They can't reach the gate's token, log or state, nor another session.

## gate.conf

- `cells_runner = kubernetes-job` turns it on. The default is `local`.
- `job_service_account = NAME`: the cells' account. Required with the runner, refused without.
- `job_image = IMAGE`: optional. Default: the ops pod's own image, by digest where a registry
  serves it (`status.containerStatuses[].imageID`), so the Job runs the same gate.
- The namespace is the ops pod's own (its kubeconfig's context): the owner reference needs it.
- Fail closed: no start with `cells_account`, `isolation = scope|bwrap`, outside a pod, or
  without a root-only `/usr/bin/kubectl`. Nor with `report_token_file` next to `gate.conf`, a
  ConfigMap there: the token goes in a Secret.

## Session start

- Before the hello, about half a second of kubectl: `config view` and `get pod HOSTNAME` (context,
  namespace, uid, image). Then the ops account's self-check, the namespace and policy checks,
  the sweep and `create -f -`.
- In the background: `get jobs,pods -l md-runbook-job=NAME` every 0.5 s until Ready, at most
  3 minutes. A bad image or a failed Job ends it at once. Then the cells' self-check in the
  pod, then the exits follower.
- Hello, `load` and `param` don't wait; the first block does, and says so on stderr. A failure
  prints the reason, logs a `job` event and ends the session (exit 2).
- Since protocol 4, a client whose hello asks for pod notices gets `starting`, then `ready` or
  `failed REASON`, instead of that line. Its time limit stops while the pod starts (the
  kube-context check's 15 s, a block's `timeout=`). A client that goes during the wait ends the
  session, and the Job goes at once.
- Latency depends on the cluster: a few seconds with the image on the node.
  - On a laptop's k3s, 30 to 60 s: container start, readiness probe, the cells' checks.
  - A first pull adds its time.

## Cells across the pod boundary

- Each shell: `kubectl exec -i -q -n NS POD -c cells -- md-runbook-gate __cells`, with sudo's
  `exec` request. Only the transport changes. The request carries the shell's number: the cells'
  mode calls `setsid` and writes its pid to `/tmp/.md-runbook-gate-shells/N`.
- Exits: appended to `/tmp/.md-runbook-gate-exits` with the run's random number, as in separated
  mode. One more exec (`__cells follow`) streams that file, and the pod's `log =` file, to the
  gate. Probe events of this session's runs are logged again, as `"source":"job"`.
  - As for the exits file (M1), anything but an expected line ends the session. So do the
    stream's early end and a run without an exit (in a session not cut short).
- Stop requests: the gate's pid file says `job NS JOB N`; `__cells stop` signals shell N's
  descendants. A shell ending mid-session: `__cells end` (TERM, KILL a second later).
- Session end: the shells finish what they were sent, then the gate deletes the Job (three
  tries). Kill and cleanup calls are bounded (5 s, `WaitDelay`).

## Cleanup

- Dead-man switch: when the follower's stdin ends (session over, or the gate gone), it sends
  TERM to PID 1 (tini). The container ends, and with `backoffLimit: 0` the Job.
- Owner reference to the ops pod; `ttlSecondsAfterFinished: 60`; `activeDeadlineSeconds:
  86400`, a cap on a live session (on-call windows stay open for hours).
- Each session start deletes Jobs of this pod whose gate is gone: label `md-runbook-gate-id`,
  pid and start time, so a reused pid doesn't count.

## The Job's pod

- Restricted: uid 10001, no privilege escalation, no capabilities, seccomp RuntimeDefault,
  read-only root, emptyDirs for `/home/ops`, `/tmp`, `/var/log/md-runbook`. Limits: 1 CPU,
  512Mi, 1Gi ephemeral storage. NetworkPolicies: no ingress to Job pods, none to sshd from them.
- `tini -- md-runbook-ops-start cells`: the kubeconfig of its own account (context
  `CLUSTER_NAME`, the ops pod's), then sleep. Ready once the kubeconfig is written.
  - Before that it waits for the API server to answer (`curl /livez`, any status), at most
    60 s. Under an egress NetworkPolicy, some plugins drop a new pod's traffic for seconds.
- Egress, opt-in (`cells-egress.yaml`): DNS and the API server's endpoint only.

## RBAC

- Ops account: a Role in its namespace: Jobs (create, list, delete), pods (get, list),
  `pods/exec` (create, get), service accounts (list). Its namespace holds the ops host alone:
  the gate refuses other pods and service accounts there.
- Cells' account: read everywhere but Secrets, ConfigMaps and pod logs. Those two, and operate
  rights, per namespace. Never bound in the ops namespace.

## Admission policies

- RBAC can't limit the shape of the Jobs the ops account creates, nor the pods it execs into.
  Workload creation implies the namespace's Secrets and service accounts (RBAC good practices).
- `apps/ops/kubernetes/admission-policy.yaml` (Kubernetes 1.30+): two ValidatingAdmissionPolicies,
  bound with `Deny` to the ops namespace, matching the ops account only. A file of its own, so
  that an update applies it without resetting the sample ConfigMap.
- `md-runbook-ops-jobs`: Job CREATE and UPDATE. It allows `jobManifest`'s shape:
  - the cells' account and label; only the gate's labels and the Job API's four, no annotations;
  - no `manualSelector`;
  - one container of the ops image's repository (a `variables` entry);
  - `emptyDir` volumes only, no `valueFrom` or `envFrom`;
  - no host namespaces or host ports, privilege escalation or added capabilities;
  - non-root and seccomp `RuntimeDefault` in the pod itself, not only through Pod Security;
  - no runtime class, node, node selector, affinity, tolerations or priority class.
- `md-runbook-ops-exec`: CONNECT on `pods/exec`, `pods/attach`, `pods/portforward`. The pod's
  name (`request.name`) must start with `md-runbook-cells-`, as the Jobs' pods do.
- Self-check, before the sweep: `kubectl create --dry-run=server` of the cells' Job as the ops
  account itself. It must fail, naming `ValidatingAdmissionPolicy 'md-runbook-ops-jobs'`.
  (CI showed that the policy runs on server dry runs.)
  - Accepted, or refused for another reason: no session. A kubectl failure or timeout says so.
  - The exec policy isn't checked: it comes in the same file.
  - The real Job refused by the policy: the message names `job_service_account` and
    `job_image`.
- No opt-out: every supported Kubernetes version has the API.

## gate_mode and the self-check

- A Job session reports `gate_mode` `separated`. The `session` event adds `cells_runner`, `job`
  and `cells`; `isolation` is `pod`. Separated mode's own checks (strays, cron) don't run.
- SelfSubjectAccessReviews per account, one `kubectl create -f -` each. A wrong answer: no
  session.
  - Ops account: it must run Jobs and exec, and hold none of the cells' rights.
  - Cells' account, in the new pod before any block. In the ops namespace: no exec, attach,
    ephemeral containers, logs, Secrets, ConfigMaps, workload or pod changes. No impersonation,
    bindings, escalation or `nodes/proxy`, with the namespace or without.
  - A namespace where the cells may change workloads (SelfSubjectRulesReviews) must enforce Pod
    Security baseline or restricted. Else a privileged pod there owns a node.
- Limits: a fixed list. The ops account's bindings elsewhere and admission exemptions are unseen.

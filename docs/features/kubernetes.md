# Kubernetes

Runbooks with `kubectl` cells work as they are. In VS Code and on the command line, they use
your own kubeconfig. Two things make them safer, and the app adds a third:

1. **The wrong-cluster guard.** `kube-context: prod-eu` in the front matter means no cell runs
   unless kubectl's current context is `prod-eu`. With `kube-context-mode: pin`, every cell runs
   against `prod-eu` instead, without changing your default context.
2. **The ops host.** The app runs runbooks against your clusters through a small SSH server. That
   server holds the cluster access, so no cluster credential is ever on a phone.
3. **Endpoint and certificate checks** from inside the cluster, kept in the run record and in
   the audit.

## The wrong-cluster guard

```markdown
---
kube-context: prod-eu
---
```

Before each cell, `kubectl config current-context` runs where the cell would run. That is in the
session shell, on the app's SSH host, or through md-runbook-gate. If it doesn't print
`prod-eu`, the cell doesn't run and says why:

```text
md-runbook: this runbook is for the Kubernetes context prod-eu, and kubectl's current context is
staging-eu: nothing ran. Switch with `kubectl config use-context prod-eu`, or open the runbook
meant for staging-eu.
```

- The check runs before every cell, not once. So it catches a `use-context` in an earlier cell,
  or a colleague switching contexts mid-incident.
- `kube-context=NAME` on a cell overrides the front matter for that cell. Use it in signed
  runbooks: the front matter isn't signed, but a cell's options are.
- On a server that only runs signed runbooks, the gate still answers the check: it only reads
  the kubeconfig. See the gate's `context` request in its [README](../../apps/gate/README.md).
- The gate also checks a signed cell's own `kube-context=` itself, before the cell runs. A
  client that skips the check can't run the cell elsewhere.
- The gate never reads the front matter. So signing refuses a front matter `kube-context:` while
  a bash block has no `kube-context=` of its own.
- Lint reports a name kubectl can't have.

### Check or pin

The check above makes you choose the cluster: the runbook refuses to run anywhere else. That is
awkward when your kubeconfig's default context is production and the runbook is for a lab
cluster. You'd have to either:

- switch your default to the lab, and remember to switch back;
- or write `--context lab` / `--kube-context lab` on every kubectl and helm command. One
  forgotten flag reaches production.

`kube-context-mode: pin` lets the runbook choose instead:

```markdown
---
kube-context: rancher-desktop
kube-context-mode: pin   # check (the default) or pin
---
```

Each cell md-runbook runs on this machine gets a `KUBECONFIG` list:

1. first, a temporary file holding only `current-context: rancher-desktop`;
2. then your own list (`$KUBECONFIG`, else `~/.kube/config`; `;` between files on Windows, `:`
   elsewhere).

This holds in VS Code and on the command line, isolated or in a session. kubeconfig merging takes
the current context from the first file that sets one, so:

- kubectl, helm, k9s and every other client-go tool in the cell use `rancher-desktop`, without
  any flag;
- your default context stays production for your terminals and other tools;
- nothing is copied out of your kubeconfig. Clusters, users and credentials are still read from
  your files, and the temporary file has none;
- a `kubectl config use-context` in a cell only changes the temporary file, and the next cell
  starts on `rancher-desktop` again. A context a cell creates with `kubectl config set-context`
  also goes to the temporary file and is lost after the run.

Before each pinned cell, `kubectl config get-contexts rancher-desktop` runs as the cell would. The
cell runs only if your kubeconfig has that context and it is the current one there:

```text
md-runbook: this runbook pins the Kubernetes context rancher-desktop, and your kubeconfig has no
context rancher-desktop (error: context rancher-desktop not found): nothing ran. `kubectl config
get-contexts` lists the ones you have.
```

- A cell's `kube-context=` pins that cell to its own context. A cell with no `kube-context` gets
  your own list. That holds in a session too, where an earlier cell's `KUBECONFIG` would
  otherwise stay.
- md-runbook sets `KUBECONFIG` for every cell of a pinned runbook. So one exported by an earlier
  cell in a session doesn't carry over.
- To use another kubeconfig, give the cell `env.KUBECONFIG=`: it becomes the list after the pin
  file. An assistant's cell with read-only credentials (`mdRunbook.approval.readOnlyEnv`) is
  pinned in front of its read-only kubeconfig.
- The temporary files, one per context, are rewritten before each cell. They are in a folder only
  you can read (0700, the files 0600).
- The temporary files are removed when the run ends (command line) or the runbook closes (VS
  Code). They aren't removed after each cell: a session shell keeps its `KUBECONFIG`, and kubectl
  skips a missing file. Skipping it would fall back to your default context.
- A background process a cell leaves running sees your default context after the files are
  removed.
- **Pin is only for cells run on this machine.** Cells on an SSH host (`host=`, everything in the
  app, a `practice:` host) are only checked as above. kubectl's current context on the host must
  already be the one named.
- Lint warns about a `host=` cell in a pinned runbook.
- Pinning gives a runbook nothing it couldn't already do: any cell can pass `--context`. It is
  still yours to switch off, with the user setting `mdRunbook.execution.kubeContextPin` (on by
  default, user settings only). Pinned runbooks are then only checked.
- With pin, opening a runbook and running it acts on its cluster whatever your current context
  is. Use pin for runbooks whose cluster is fixed (a lab, one runbook per cluster). Keep the check
  for runbooks where you should have switched on purpose.

### The context from a parameter

Some runbooks make the same change on several clusters, tried on a lab first. For them, make the
context a [parameter](../syntax.md#front-matter) whose default can only touch the lab.

```markdown
---
params:
  - CONTEXT: rancher-desktop
kube-context: ${param:CONTEXT}
kube-context-mode: pin
---
```

A run without parameters pins `rancher-desktop`. For production, give the context:

- on the command line: `md-runbook run sessionstore-limits.runbook.md --param CONTEXT=prod-eu`;
- in VS Code, type it when it asks (**md-runbook: Set Parameters**);
- in the app, on the Parameters card.

No `--context` is needed on the kubectl and helm commands.

- The value must be a context name (letters, digits, `. _ : @ / + -`): anything else, or no value,
  and nothing runs.
- `pin` and the check work as for a name written out. The command line's step line says
  `Kubernetes context prod-eu` and every output marker records `kube-context=prod-eu`, because
  the value isn't in the file.
- A cell's `kube-context=${param:NAME}` works the same, for that cell.
- **Signed runbooks.** A cell's options are signed, so `kube-context=${param:CONTEXT}` on a cell
  needs a pattern when you sign (`--pattern CONTEXT='rancher-desktop|ocpasni-test'`).
- The app runs such a cell only with a value that matches. A signed runbook can't then be pointed
  at a cluster its signer did not allow.
- The front matter isn't signed: in a signed runbook, put the parameter on the cells.
- Lint treats it as any other parameter: an undeclared one is reported.

### Git Bash and paths in kubectl commands (Windows)

On Windows, bash cells run in Git Bash. When Git Bash starts a Windows program, it rewrites
arguments that look like POSIX paths. For example, `kubectl exec pod -- bash /opt/x/probe.sh`
reaches kubectl as `C:/Program Files/Git/opt/x/probe.sh`.

`git-bash-path-conversion: off` in the front matter sets `MSYS_NO_PATHCONV=1` and
`MSYS2_ARG_CONV_EXCL=*` for the runbook's bash cells on Windows. So such arguments reach kubectl
as written.

It has no effect on other systems, or on PowerShell and cmd cells. Conversion is turned off only
when asked for, since some commands need it (a Windows program given `/c/Users/me/file`).

## The ops host

The app can't use your laptop's kubeconfig, and it shouldn't carry its own. Cloud logins (AWS
IAM for EKS, Google for GKE, Entra ID for AKS) each need their own client. A long-lived cluster
token on a phone is the worst key to lose.

Instead the app connects by SSH to the **ops host** ([apps/ops](../../apps/ops/README.md)), and
kubectl runs there:

- **Inside the cluster (recommended).** A Deployment whose service account is the only identity:
  - Kubernetes rotates its token, and a ClusterRole decides what runbooks may do.
  - The default role reads everything except Secrets, restarts, rolls back and scales, and
    doesn't delete.
  - Works the same on EKS, GKE, AKS and your own clusters.
  - Pod Security `restricted`, non-root, read-only root filesystem.
- **Next to the relay.** The same image as a service in the relay's compose file, with a
  kubeconfig you mount.

Either way, every login goes to md-runbook-gate. Out of the box it runs signed runbooks only,
and it logs every request.

Logins take keys from `authorized_keys`, or [SSH certificates](ssh-certificates.md) from your
company CA. With certificates, the log names the person (the key ID), and leaving needs no key
list change.

To the app, the ops host is a host like any other:

- add it under **Hosts & settings**;
- put its name in a [host group](../app.md#hosts-and-the-apps-key) per cluster;
- pin runbooks to it with `host=`.

### Who in the Kubernetes audit log

Each session's blocks run as one service account, `md-runbook-cells`. So the cluster's audit log
can't tell people apart; the gate's log can. `job_audit_who = yes` in `gate.conf` (off by
default) puts the person into the audit log too.

How:
- The Job's kubectl impersonates **its own** service account, with one user extra:
  `md-runbook.dev/operator`.
- `md-runbook.dev/operator` holds the gate's `who`: the certificate's key ID, else the key's
  fingerprint (or `--who=`).
- Same user name, same groups: the same rights. The admission policies still match it.
- Each audit event then has:
  - `user`: `md-runbook-cells`, with the pod's name in its extra
    (`authentication.kubernetes.io/pod-name`). The API server sets it; no block can change it.
  - `impersonatedUser`: `md-runbook-cells` again, with `md-runbook.dev/operator: [alice@example.com]`.
- The impersonated identity has no UID and none of the token's extras. A policy of yours keyed on
  those sees another identity. RBAC and the md-runbook admission policies don't use them.

Set it up:
1. `kubectl apply -f apps/ops/kubernetes/impersonation.yaml` (a Role and a ClusterRole).
2. Add `job_audit_who = yes` to `gate.conf`, then restart the ops Deployment.
3. Your audit policy logs at level `Metadata` or more: `user` and `impersonatedUser` are in
   every event.

Needs Kubernetes 1.30 or later, as the admission policies do.

What a block can't do:
- Impersonate anyone else: the Role names `md-runbook-cells` only (`resourceNames`), in
  `md-runbook-ops` only. No users, no groups, no uids.
- Set another extra key, such as the pod's.
- Gain a right: the impersonated account is the same account.

What a block can do, so the gate's log stays the authority:
- **Drop the impersonation.** The audit event then shows `md-runbook-cells` and its pod, as
  without `job_audit_who`.
- **Set another value** in `md-runbook.dev/operator`. RBAC can limit an extra's values, but not
  per session: every session's pod has the same account.

The extra is a claim. To check it, follow the event's pod name (the API server's word) to the
gate's `job` event with that `pod`. That event names `who`.

A missing extra is no sign of tampering. These skip the kubeconfig: a runbook's own `KUBECONFIG`,
an SDK's in-cluster config, `curl` with the pod's token.

`who` is in the Job's env (`MD_RUNBOOK_KUBE_WHO`). Whoever may read Jobs or pods in
`md-runbook-ops` sees it.

What the gate checks at each session, before any block:
- `kubectl auth whoami` in the pod shows `md-runbook-cells`, with `who` and no other extra. Else
  no session: the RBAC is missing, or `job_image` is older than the gate.
- `who` is printable ASCII, at most 256 bytes. Else no session.
- The gate reads the cells' rules per namespace (a `SelfSubjectRulesReview` each), with or
  without `job_audit_who`.
  - Allowed: impersonation.yaml's two rules.
  - Allowed: service accounts of a namespace other than `md-runbook-ops`, if the cells may create
    their tokens there. That is `create serviceaccounts/token` without `resourceNames`.
    Kubernetes' `edit` and `admin` roles grant both.
  - The cells may impersonate service accounts only where they may already act as them. A token
    is that already; pods aren't: `md-runbook-ops-workloads` keeps the account of the cells'
    pods.
  - Why the token right matters: impersonated requests escape `md-runbook-ops-workloads`. The
    policy matches the cells' user name, and the API server swaps it before admission.
  - Such a namespace counts as one where the cells run workloads, and so does one with the token
    right alone. It must enforce Pod Security and can't be `kube-*`.
  - None of its service accounts may have a ClusterRoleBinding. RoleBindings elsewhere the gate
    can't see: don't bind `edit` where an account has rights in other namespaces.
  - Refused: `impersonate` or `*` on users, groups, uids, nodes or user extras. Names don't help:
    `users [kubernetes-admin]` is refused too.
  - Refused: any service account in `md-runbook-ops` but `md-runbook-cells`. A ClusterRoleBinding's
    rule shows up there too.
  - Refused: any verb of constrained impersonation (`impersonate:…`, `impersonate-on:…`).
- Questions without a name back this up (`SelfSubjectAccessReview`).
  - They ask the classic verb and constrained impersonation's verbs.
  - By name, they ask about the gate's account, `system:masters` and the pod's extras.

What it can't check: rights a webhook authorizer gives (the rules review is then incomplete).
Only the questions above hold there, and they can't see rights limited to names.

Not covered: the gate outside a cluster (`kubeconfig =` in `gate.conf`). There the kubeconfig is
yours: give each person their own if the audit log must name them.

Why this design (checked 2026-11-27):
- **Not one Kubernetes user per person.** RBAC can limit impersonation to listed users.
  - But every block of every session could act as any of them.
  - The audit log would then name the wrong person, with full confidence.
  - The admission policy `md-runbook-ops-workloads` matches the cells' user name: it wouldn't
    hold such a user.
- **Not constrained impersonation** ([KEP-5284](https://kep.k8s.io/5284): alpha in Kubernetes
  1.35, beta and on by default in 1.36). Its service-account mode takes the user name only, no
  extras. A request with an extra falls back to the classic `impersonate` check.
- **Confidence: high** on what RBAC allows. It rests on the API server's impersonation code
  (`staging/src/k8s.io/apiserver/pkg/endpoints/filters/impersonation/mode.go`).
- **Confidence: medium** on managed clusters' audit pipelines: they should keep
  `impersonatedUser`. Check yours. CI checks a kind cluster's audit log.

Sources:
- [User impersonation](https://kubernetes.io/docs/reference/access-authn-authz/user-impersonation/):
  the headers, `userextras/KEY`, `resourceNames`, constrained impersonation, the audit fields.
- [Audit Event](https://kubernetes.io/docs/reference/config-api/apiserver-audit.v1/): `user`,
  `impersonatedUser`.
- [kubeconfig](https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/): `as`,
  `as-user-extra`.
- [Bound service account tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/):
  the node's name and the credential ID in the token's extra, stable since 1.32. The pod's name
  is older: `PodNameKey` is in
  [Kubernetes 1.19's `pkg/serviceaccount`](https://pkg.go.dev/k8s.io/kubernetes@v1.19.8-rc.0/pkg/serviceaccount).
- [Environment variables](https://kubernetes.io/docs/tasks/inject-data-application/define-interdependent-environment-variables/):
  the kubelet expands `$(VAR)`, not `$$(VAR)`. The gate doubles each `$` of `who` (CI checks a key ID with `$(id)`).

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
- **In the record.** Exports of an incident or drill record carry each check: when, which step,
  which endpoint, up or not, certificate expiry. Export Report (HTML, PDF) lists them under
  **Endpoint checks**; the JSON export carries the same data.
- **In the audit.** Each check is a `probe` event in the gate's log;
  [`md-runbook audit`](for-auditors.md) lists these events. An event records:
  - the key, the client and the signed run that made it;
  - the address and the result;
  - the certificate's expiry and SHA-256 fingerprint.

[examples/kubernetes.runbook.md](../../examples/kubernetes.runbook.md) puts it together:

1. Checks the cluster, the API server, every Ingress, your own endpoints and cert-manager's
   certificates.
2. Then restarts a deployment, and rolls it back if needed.

### Options

| Option | What it does |
| --- | --- |
| `--days N` | fail when a certificate expires within N days (default 14) |
| `--timeout S` | seconds per connection (default 5) |
| `--ca FILE` | trust this CA in addition to the system's CAs, e.g. the cluster's `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` |
| `--ca-only FILE` | trust this CA and no other |
| `--no-verify` | report the expiry without checking trust or the name (self-signed endpoints) |
| `--tls`, `--no-tls` | check TLS on every port, or on none; otherwise on 443, 6443, 8443, 9443, 465, 636, 993 and 995 |
| `--ping` | also ping (ICMP is often blocked, or not allowed in a container) |
| `--format F` | `text` (the lines above, the default), `json` or `prometheus` |
| `--label NAME=VALUE` | add a label to every metric and JSON object (repeatable); `NAME=VALUE` after a target labels that target only |

A target is `host`, `host:port`, `[v6]:port` or a URL:

- `https://host/path`;
- `tls://host:port`: always check TLS, on any port;
- `tcp://host:port`: only TCP.

The `tls://` and `tcp://` forms win over `--tls` and `--no-tls`. `-` reads targets from stdin.
The exit code is 1 when a check failed and 2 on bad usage, in every format.

Up to 0.11.0, `--ca` replaced the system's CAs, so with it public endpoints were reported as
*not trusted*. `--ca-only` does that now.

### Formats and labels

`--format json` prints one object per target and line (JSON Lines), with these fields:

- `target`, `ok`, `address`;
- `reachable` (a TCP connection opened), `tcp_ms`;
- `tls` (TLS checked), `trusted` (`null` when not checked);
- `not_after`, `days_left`, `subject`, `issuer`;
- `detail` (the text line's detail), `time` and `labels`.

```json
{"time":"2026-10-27T10:00:01Z","target":"shop.example.net:443","ok":false,"address":"203.0.113.9","reachable":true,"tcp_ms":20,"tls":true,"trusted":true,"not_after":"2026-11-05T12:00:00Z","days_left":9,"subject":"shop.example.net","issuer":"R11","detail":"203.0.113.9, tcp 20ms, certificate expires in 9 days (2026-11-05), under 14, CN=shop.example.net, issuer R11","labels":{"component":"shop"}}
```

`--format prometheus` prints metrics in Prometheus's text format, gauges labelled
`target="host:port"` and with the target's labels:

| Metric | Value |
| --- | --- |
| `md_runbook_probe_ok` | 1 if every check of the target passed, else 0 |
| `md_runbook_probe_reachable` | 1 if a TCP connection opened, else 0 |
| `md_runbook_probe_certificate_expiry_timestamp_seconds` | when the certificate expires (Unix time); only TLS targets with a certificate |
| `md_runbook_probe_last_run_timestamp_seconds` | when the target was checked (Unix time) |

```text
md_runbook_probe_ok{target="shop.example.net:443",component="shop"} 0
md_runbook_probe_certificate_expiry_timestamp_seconds{target="shop.example.net:443",component="shop"} 1793880000
```

Labels come from two places:

- `--label NAME=VALUE` is on every target.
- `NAME=VALUE` words after a target are on that target only, and win over a `--label` of the
  same name. On the command line, they label the target just before them. On a stdin line, they
  label every target on that line.

So one run, and one scrape, can tell components apart, even where two share an endpoint:

```sh
md-runbook-probe --format prometheus --label cluster=prod - <<'EOF'
tls://idm-web:8989 component=proxy
tcp://mariadb.mariadb.svc:3306 component=auth
tcp://mariadb.mariadb.svc:3306 component=admin4
EOF
```

```text
md_runbook_probe_ok{target="mariadb.mariadb.svc:3306",cluster="prod",component="auth"} 1
md_runbook_probe_ok{target="mariadb.mariadb.svc:3306",cluster="prod",component="admin4"} 1
```

- Label names are Prometheus label names: letters, digits and `_`, not `target`, not starting
  with `__`, once per target.
- Label values have no control characters; quotes and backslashes are escaped.
- A label before any target is bad usage (exit 2).
- A word that doesn't start like a label (`NAME=`) is a target, and checked as one.
- In Prometheus format, a target with the same labels twice is one series. The same target with
  other labels is another.
- The text format prints no labels: a target listed twice is two lines.

### Audit outside the gate

Where the gate runs the probe (on the ops host), its `gate.conf` decides where the events go.
Nothing else can change that.

Elsewhere, e.g. `kubectl exec` into a Pod, the environment variable `MD_RUNBOOK_PROBE_LOG` may
name a file, `stderr` or `syslog`. Without it, nothing is logged.

In a container, `MD_RUNBOOK_PROBE_LOG=/proc/1/fd/1` puts the events into the container's log,
where `kubectl logs` and `md-runbook audit` find them. If the destination can't be written (a
read-only filesystem, no syslog), the probe says so once on stderr.

### The probe image

The probe also comes alone, as `ghcr.io/smojon/md-runbook-probe`
([apps/probe](../../apps/probe/README.md)): no sshd, no gate, no kubectl, non-root, the probe
as its entrypoint. Its example manifest runs it as a Pod next to your services:

- every 60 s, with `--format prometheus` and a sidecar that serves the metrics;
- without a service account token;
- with a read-only root filesystem.

## Not there yet

- Pods aren't hosts: the app doesn't open `kubectl exec` sessions into a pod by itself. A cell
  on the ops host can run `kubectl exec` if you give the role `pods/exec`.
- The ops host image has kubectl, but not the cloud CLIs (`aws`, `gcloud`, `az`). Inside a
  cluster it doesn't need them.

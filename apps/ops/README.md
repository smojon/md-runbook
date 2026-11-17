# md-runbook ops host

A small SSH server for running runbooks against your clusters from the md-runbook app. It is
an ordinary host in the app, but every login goes to md-runbook-gate, and `kubectl` is
installed. Cluster credentials stay on this host and never reach a phone.

The guide is [docs/features/kubernetes.md](../../docs/features/kubernetes.md).

- **sshd** runs as the account `ops` (uid 10001), not as root, on port 2222. It accepts keys
  only: no passwords, no forwarding, no terminal.
- **md-runbook-gate** is the only command
  ([apps/gate](../gate/README.md)). It runs signed runbooks, and unsigned cells only where
  `gate.conf` allows them. It logs every request, and its log is printed to the container's
  output.
- **kubectl** logs in with the Pod's service account inside a cluster, or with a kubeconfig you
  mount outside one. The kubeconfig's context name is what runbooks write as `kube-context:`.
- **In a cluster, each session's blocks run in a Job of their own** (below). They never run in
  the pod that holds the gate.
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

## Trust

In a cluster, blocks run in a Job of their own: see [A Job per session](#a-job-per-session).
Outside a cluster, every block runs as the account `ops`, which can read the host key and the
kubeconfig:
- **Keep `unsigned = refuse` in `gate.conf`.** An unsigned block can do anything `ops` can.
- **After any time with `unsigned = allow`, make a new host key** and put it in the Secret. A
  block could have copied the old one, and a copy can pose as this host.
  - Change a mounted kubeconfig's credentials and the report token too.
- **The log is a file `ops` can write**, so a block can change it. The container's output keeps
  each line as it was written: rely on that copy (`kubectl logs`).
- **Its run reports are only as good as its signed blocks:** a block can read the report token.
  The gate's README says what a gate's word needs: [Trust](../gate/README.md#trust).
- `gate.conf` here has `sshd_force_command = yes`: sshd runs the gate for every login, so the key
  lines need no `command=`.
  - The gate takes it only from a `gate.conf` that `ops` can't change. A read-only mount is fine.
  - Only with `--sshd-force-command`, which the image's `ForceCommand` line has.
  - `sshd_config` turns off forwarding, the terminal and `~/.ssh/rc` (`PermitUserRC no`).
- `gate.conf` here has `kill_leftovers = yes`. At the start and end of each session, the gate
  ends the programs of `ops` that outlived their session, such as a block's `setsid` program.
  - Keep it in your own `gate.conf`: else such a program could write into a later session's
    shell.
  - `docker exec` and `kubectl exec` shells are spared.
- **The login shell of `ops` is `/bin/sh`.** With bash, sshd ran `~/.bashrc`, a file `ops` can
  write, before the gate. Blocks still run in bash.

## In a cluster

[kubernetes/md-runbook-ops.yaml](kubernetes/md-runbook-ops.yaml) sets up:
- the namespace `md-runbook-ops`, with Pod Security `restricted` enforced;
- the service account `md-runbook-ops` of the ops pod: it may only run the sessions' Jobs;
- the service account `md-runbook-cells` of those Jobs, and what runbooks may do:
  - read everything except Secrets, ConfigMaps and pod logs, in every namespace, cert-manager
    certificates included;
  - `rollout restart`, `rollout undo`, scale Deployments and StatefulSets, create Jobs from
    CronJobs, read pod logs and ConfigMaps, only in the namespaces you bind (see below);
  - nothing else: no deleting, no exec into pods, no DaemonSets;
- the gate's ConfigMap, the Deployment and a ClusterIP Service on port 22;
- NetworkPolicies: the Job pods take no connection, and can't reach the ops pod's sshd.

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

**Run reports.** The bearer token goes in a Secret, never in the gate's ConfigMap: blocks can't
read Secrets here.

```sh
kubectl $ns create secret generic md-runbook-ops-report-token --from-file=token
# In gate.conf: report_to = https://…/v1/runs and
#               report_token_file = /etc/md-runbook-ops/report/token
```

The gate refuses a `report_token_file` in the folder of `gate.conf`.

**Reaching it from a phone.** The Service only works inside the cluster. You have three
options:
- **A LoadBalancer.** `kubectl $ns patch service md-runbook-ops -p '{"spec":{"type":"LoadBalancer","loadBalancerSourceRanges":["203.0.113.0/24"]}}'`
  exposes it; limit the source ranges to your own addresses.
- **A VPN** into the cluster's network.
- **The relay in the cluster**, for the web app ([apps/relay](../relay/README.md), with
  `RELAY_TARGETS=md-runbook-ops.md-runbook-ops.svc:22`).

**Where runbooks may change things.** Nowhere at first. For each namespace your runbooks may
change, enforce Pod Security, then bind it:

```sh
kubectl label namespace NAMESPACE pod-security.kubernetes.io/enforce=baseline
kubectl -n NAMESPACE create rolebinding md-runbook-ops-operate \
  --clusterrole=md-runbook-ops-operate --serviceaccount=md-runbook-ops:md-runbook-cells
```

- **Pod Security `baseline` or `restricted` is required.** Without it a block could start a
  privileged pod there and own its node, with every pod on it. The gate checks each namespace
  the blocks may change, and refuses to start a session if one doesn't enforce it.
  - A cluster-wide exemption of that namespace in the admission configuration undoes the label.
    The gate can't see it.

- Bind only the namespaces you need. Whoever may change a namespace's workloads can read its
  Secrets ([Kubernetes RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/#workload-creation)).
- Never bind `kube-system`, and never `md-runbook-ops` itself. The gate refuses to start a
  session there.
- **More rights:** add rules to `md-runbook-ops-operate`. Whatever it allows, every runbook on
  this host can do.

**Coming from 0.28 or before:** the bindings named the ops pod's account. Move each one to the
cells' account, and remove the one in `md-runbook-ops`:

```sh
kubectl -n NAMESPACE delete rolebinding md-runbook-ops-operate
kubectl -n NAMESPACE create rolebinding md-runbook-ops-operate \
  --clusterrole=md-runbook-ops-operate --serviceaccount=md-runbook-ops:md-runbook-cells
kubectl -n md-runbook-ops delete rolebinding md-runbook-ops-operate
```

Label each bound namespace too (above). Move a report token out of the gate's ConfigMap into
the Secret.

Update the image before the ConfigMap: an older gate refuses the new `gate.conf` lines.

### A Job per session

`gate.conf` in the cluster has `cells_runner = kubernetes-job`. For each SSH session, the gate:
1. checks its own service account: it may run Jobs here, and has none of the cells' rights;
2. starts a Job of the same image, as `job_service_account` (`md-runbook-cells`);
3. checks the cells' account in the new pod:
   - in `md-runbook-ops` it can't exec into pods, read pod logs, Secrets or ConfigMaps, or
     start workloads;
   - each namespace where it may change workloads enforces Pod Security;
4. runs the session's blocks there with `kubectl exec`;
5. deletes the Job when the session ends.

What this keeps apart:
- Blocks can't read the gate's report token, its log or its state, nor the ops pod's token.
- Two sessions never share a pod.
- Run reports say `gate_mode` `separated`.

What you see:
- The first block of a session waits for the pod, and the app and VS Code say "Starting the
  session's pod…".
  - How long depends on the cluster: a few seconds where the node has the image, 30 to 60
    seconds on a laptop's k3s.
  - A first image pull adds its time.
  - The wait doesn't count against the kube-context check or a block's `timeout=`.
  - Stop works during the wait: the session ends and the gate deletes the Job.
- If the pod can't start, the session ends with the reason, such as a wrong image.
  - The gate waits at most 180 seconds for the pod, then ends the session with that reason.
- The log has `job` events: `created`, `ready` (with the seconds it took), `deleted`.

Cleanup, if the gate can't delete a Job itself:
- the pod ends itself when the gate's connection to it ends;
- the Job belongs to the ops pod, so it goes when that pod does;
- the next session deletes Jobs whose gate (pid and start time) is gone;
- a session lasts at most a day, a cap for long on-call windows.

**Network.** The NetworkPolicies need a network plugin that enforces them.
- Egress stays open for runbooks. Where a cloud's metadata address (169.254.169.254) gives
  out node credentials, block it with a policy of your own: that part is cluster-specific.
- Some plugins also apply an `ipBlock` to pod addresses. There the Job pods can still reach
  sshd, but they have no key to log in.

Settings in `gate.conf`:
- `job_service_account = NAME`: required.
- `job_image = IMAGE`: optional. The default is the ops pod's own image.
- Outside a cluster, remove `cells_runner` and `job_service_account`.

**Your own cells' service account.** With another `job_service_account` than
`md-runbook-cells`, give it what the manifest gives that one:
- `get` and `list` on `namespaces`, cluster-wide (the ClusterRole `md-runbook-ops` has them):
  the gate's namespace check needs them.
  Without them the session refuses with "can't list the namespaces".
- `imagePullSecrets` for a private registry. The gate's Job names none, so the pod takes them
  from its service account:
  `kubectl -n md-runbook-ops patch serviceaccount NAME -p '{"imagePullSecrets":[{"name":"SECRET"}]}'`.
  This also goes for `md-runbook-cells` itself.

## Next to the relay

The relay's [compose.example.yml](../relay/compose.example.yml) has an `ops` service:

```sh
cd apps/relay
cp -r ../ops/example ops        # keys/, gate/, kubeconfig/: fill them in
docker compose --profile ops up -d
```

Phones connect to port 2222 of that machine. The web app goes through the relay: add
`ops:2222` to `RELAY_TARGETS`.

Outside a cluster, kubectl needs a kubeconfig in `ops/kubeconfig/config`. Use a service account
token with the rights above, not your own login.

The cloud logins of EKS, GKE and AKS need their own CLIs, which this image doesn't have. So this
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
   the certificate:
   - it must be trusted;
   - it must be for that name;
   - it must not expire within `--days` (default 14).

   `--ca FILE` trusts that CA in addition to the system's CAs, `--ca-only FILE` trusts it alone.

It prints one line per target. Its exit code is 1 when any check failed, so a cell fails on it.

- `--ping` also pings. ICMP is often blocked, and a container may not be allowed to send it. In
  that case the line says so.
- `--format json` and `--format prometheus` print the same checks for other programs. Labels
  come from `--label NAME=VALUE` or per target (`tls://web:8443 component=proxy`)
  ([all options](../../docs/features/kubernetes.md#options)).

To run only the probe, e.g. as a Pod next to your services, use the
[probe image](../probe/README.md). It has no sshd, no gate, no kubectl.

What keeps it as safe as the rest:
- **It runs only as a cell**, through the gate: signed runbooks only, unless `gate.conf` allows
  unsigned cells. A target is a host name, an IP address or a URL. Nothing else gets through:
  no option for openssl or ping, no spaces, no shell characters.
- **The probe writes an audit event for every check** to the gate's log, which is also the
  container's output. Each event records:
  - the key, the client, and the signed run that started the check;
  - the target, its address and the result;
  - the certificate's expiry and SHA-256 fingerprint.

  `md-runbook audit` lists these events under Endpoint checks. Here `gate.conf` alone decides
  where they go; `MD_RUNBOOK_PROBE_LOG` only applies where no gate runs the probe.
- **Export Report shows the checks** of a run record (an incident or a drill) in an Endpoint
  checks table:
  - when each check ran;
  - which endpoint;
  - up or not;
  - when its certificate expires.

  The JSON export has the same data.

## Build it

```sh
docker build -t md-runbook-ops -f apps/ops/Dockerfile apps
```

- **The gate** is built from its Go source in `apps/gate`, so the build context is `apps/`.
  - A build stage compiles it with the toolchain `apps/gate/go.mod` names, in a `golang` image
    pinned by digest.
  - The image gets only the static binary.

`KUBECTL_VERSION` (a build argument) picks kubectl, and the build checks the download against
its published SHA-256.

Each md-runbook release publishes the image as `ghcr.io/smojon/md-runbook-ops`. The
[Ops host workflow](../../.github/workflows/ops.yml) tests
it in a kind cluster and outside one.

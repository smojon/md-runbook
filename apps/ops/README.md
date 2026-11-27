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
| `/etc/md-runbook-ops/keys/user_ca`, `authorized_principals`, `revoked_keys` | [SSH certificates](#ssh-certificates): your CA, its principals, revoked keys | no certificate logs in |
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
  each line as it was written: rely on that copy, shipped off the host
  ([The audit log](#the-audit-log-and-a-stolen-key)).
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
- the service account `md-runbook-ops` of the ops pod: it runs the sessions' Jobs, reads one
  admission policy and lists ClusterRoleBindings;
- the service account `md-runbook-cells` of those Jobs, and what runbooks may do:
  - read everything except Secrets, ConfigMaps and pod logs, in every namespace, cert-manager
    certificates included. That covers every pod's spec, with the env values written in it.
    Keep passwords and tokens in Secrets (`secretKeyRef`), not in plain `value`s;
  - `rollout restart`, `rollout undo`, scale Deployments and StatefulSets, read pod logs and
    ConfigMaps, only in the namespaces you bind (see below);
  - nothing else: no deleting, no exec into pods, no DaemonSets, no Jobs (opt-in, below);
- the gate's ConfigMap, the Deployment and a ClusterIP Service on port 22;
- NetworkPolicies: the Job pods take no connection, and can't reach the ops pod's sshd.

[kubernetes/admission-policy.yaml](kubernetes/admission-policy.yaml) holds the admission
policies:
- the gate's account may create only the cells' Jobs, and exec only into their pods;
- the cells' account may restart and scale workloads, not change who their pods run as.

Apply both as a cluster admin: the ClusterRoles and the policies are cluster-wide. They need
Kubernetes 1.30 or later.

```sh
kubectl apply -f apps/ops/kubernetes/md-runbook-ops.yaml -f apps/ops/kubernetes/admission-policy.yaml
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

**Keep your settings in your own copy.** Applying the stock `md-runbook-ops.yaml` again resets
them:
- the ConfigMap `md-runbook-ops-gate` (`gate.conf`, your signers, `signers = 2`, `report_to`);
- the Deployment's `CLUSTER_NAME` and image.

So keep a copy of the manifest with your settings, in git. At each update, take the release's
changes into it (the "Coming from" notes below list them), then apply your copy.

**Run reports.** The bearer token goes in a Secret, never in the gate's ConfigMap: blocks can't
read Secrets here.

```sh
kubectl $ns create secret generic md-runbook-ops-report-token --from-file=token
# In gate.conf: report_to = https://…/v1/runs and
#               report_token_file = /etc/md-runbook-ops/report/token
```

The gate refuses a `report_token_file` in the folder of `gate.conf`.

**A namespace of its own.** Keep `md-runbook-ops` for the ops host alone. Put the relay, the web
app and everything else in other namespaces.
- Its Role lets the gate exec into every pod of its namespace, and start Jobs as any service
  account there. The admission policies stop both. Without them, a compromised gate would get
  the other apps' rights too.
- At each session the gate checks this. It refuses when the namespace has:
  - a pod that runs as another service account than `md-runbook-ops` or `md-runbook-cells`;
  - a service account other than those two and `default`.
- Bind no role to `default` in this namespace.
- The manifest's NetworkPolicy lets every address reach sshd. Its `ipBlock`s 0.0.0.0/0 and ::/0
  cover clients outside the cluster, and on some network plugins every pod too. To narrow it:
  - replace those `ipBlock`s with your clients' ranges (a load balancer's, a VPN's, a
    connector's);
  - set its `namespaceSelector` to the relay's namespace.
- At each session the gate also checks that this namespace enforces Pod Security `restricted`,
  as the manifest labels it.

**The admission policies.** RBAC can't limit the shape of a Job, nor which pod to exec into.
So the gate's account could:
- create a Job as another service account, its own or `default`;
- mount the host key, the report token or `gate.conf` in it, as a volume or env;
- drop the label the NetworkPolicies select;
- pick host namespaces, a `hostPath`, a node, a runtime class, or another image;
- exec into the ops pod itself, with its Secrets.

The ValidatingAdmissionPolicy `md-runbook-ops-jobs` refuses those Jobs. For the gate's account
in `md-runbook-ops`, a Job must have:
- the service account `md-runbook-cells` and the label `app.kubernetes.io/name=md-runbook-cells`;
- no other labels than the gate's and the Job API's, and no annotations;
- one container, of the ops image's repository (any tag or digest);
- `emptyDir` volumes only, and no env from Secrets or ConfigMaps;
- no host namespaces or host ports, no privilege escalation, no added capabilities;
- non-root, seccomp `RuntimeDefault`;
- no runtime class, node, node selector, affinity, tolerations or priority class.

The policy `md-runbook-ops-exec` lets the gate's account exec only into pods named
`md-runbook-cells-…`: its Jobs' pods.

Your own Jobs and execs aren't affected, nor other accounts'.

At each session the gate checks `md-runbook-ops-jobs`: a dry run of a Job as its own account
must fail. Else the session refuses with `the admission policy md-runbook-ops-jobs doesn't
guard the Jobs`.

The policy `md-runbook-ops-workloads` holds the cells' account, in every namespace. RBAC lets it
patch a Deployment's pod template. So without the policy, a runbook could:
- run the pods as another service account of that namespace;
- add a Secret as a volume or env, or a container;
- pick host namespaces, a node, tolerations or a runtime class.

The policy compares each change with the object as it was. It refuses a change to:
- the template's service account and token mount;
- its volumes, and the names of its containers and init containers;
- where env comes from (`envFrom`, `valueFrom`), plain values aside;
- the security context, host namespaces and host ports;
- the node, node selector, affinity, tolerations and runtime class.

What still passes:
- `kubectl rollout restart`: it changes an annotation only;
- `kubectl scale`: the scale subresource, which the policy doesn't match;
- `kubectl set image`, and `kubectl set env` with plain values;
- `kubectl rollout undo`, to a revision with the same fields as above.

It stops a change of which account the pods run as. It doesn't stop:
- a new image running any code as the workload's own account, with the Secrets it mounts.

The gate covers that only for cluster-wide rights (below). So bind only namespaces whose
workloads may do what any runbook may do.

What the cells create (opt-in Jobs) has nothing to compare with. It must:
- run as the account `default`;
- mount no Secret, as a volume or env;
- for a Job: name a CronJob as its controller, as `kubectl create job --from=cronjob/NAME` does.
  A runbook can write that line itself: it states the intent, the two rules above hold.

Each change must also be in a namespace that enforces Pod Security `baseline` or `restricted`,
outside `kube-*` and `md-runbook-ops`. The gate checks this when a session starts. The policy
then holds it for the session's length: a label removed meanwhile, or a namespace bound later.

At each session, if the cells may change workloads somewhere, the gate reads the policy and its
binding. They must deny in every namespace. Else the session refuses with `the admission policy
md-runbook-ops-workloads or its binding is missing`.
- A policy from before 0.33.0 lacks the namespace rule: the session refuses. Apply
  `admission-policy.yaml` again.
- While a session lasts, the gate reads the policy and the ClusterRoleBindings again, every 5
  minutes. If it would now refuse the session, the session ends.

**A mirror of the image:** change the `repository` variable in `admission-policy.yaml`. That's
one line.

**Two signers in production.** For runbooks that change a cluster, set `signers = 2` in
`gate.conf`. Then one stolen signing key can't run a change alone.

**Scopes and old versions.** `scopes = *` runs runbooks signed for any scope, in any version
ever signed. A stolen SSH key can then run a staging runbook here, or an old buggy version.
- Set `scopes = prod-eu` (this cluster), and sign its runbooks with `--scope prod-eu`. A runbook
  without scopes then doesn't run here.
- Withdraw old versions: add `floors` and `revoked` files to the ConfigMap, next to
  `allowed_signers`. In `gate.conf`: `floors = /etc/md-runbook/floors`, `revoked = /etc/md-runbook/revoked`.
- Sign with `--expires-in DAYS`, so a release stops by itself.
- See [Withdrawing a release](../../docs/features/signed-runbooks.md).

**Reaching it from a phone.** The Service only works inside the cluster. You have four
options:
- **No open port:** a Tailscale or Cloudflare connector dials out
  ([without an open port](../../docs/features/ops-outbound.md)).
- **A LoadBalancer.** `kubectl $ns patch service md-runbook-ops -p '{"spec":{"type":"LoadBalancer","loadBalancerSourceRanges":["203.0.113.0/24"]}}'`
  exposes it; limit the source ranges to your own addresses.
- **A VPN** into the cluster's network.
- **The relay in the cluster**, for the web app ([apps/relay](../relay/README.md), with
  `RELAY_TARGETS=md-runbook-ops.md-runbook-ops.svc:22`).

**Client addresses.** The gate logs each client's address.
- Behind a LoadBalancer, that's a node's address by default. Add
  `"externalTrafficPolicy":"Local"` to the patch above to keep the client's own.
- `from="203.0.113.0/24"` before a key in `authorized_keys` limits where it may log in from. It
  needs the client's own address.
- Behind a relay, a connector or SNAT, every client has the same address. So `from=` can't tell
  them apart.
- After failed logins, sshd refuses that address for a while: from 15 seconds, up to 10
  minutes (OpenSSH's `PerSourcePenalties`). With one shared address, one client with a wrong
  key locks the others out too, until it lifts by itself.
- A client that stops answering (a phone out of coverage): sshd ends its session after 5
  minutes. Its Job goes too.

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

**What a binding gives every runbook.** Binding a namespace lets runbooks act with its workloads:
- restart, roll back and scale them;
- change their image (`kubectl set image`). The new image's code runs as the workload's service
  account, with the Secrets it mounts. Runbooks can thus run code as any account a workload
  there uses.
- with `jobs create` opted in: run pods of their own there. Without the policy, as any of its
  service accounts.

See [Kubernetes RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/#workload-creation).

**The gate refuses namespaces with cluster-wide accounts.** At each session it lists the
ClusterRoleBindings. It refuses a namespace runbooks may change when one names:
- a service account of that namespace (as a ServiceAccount, or its user name);
- or the group `system:serviceaccounts:NAMESPACE`.

The message names up to three: `ACCOUNT → CLUSTERROLE (binding NAME)`. Bindings to every account
(`system:serviceaccounts`, `system:authenticated`) don't count: the cells have those rights too.

What it can't see:
- RoleBindings in other namespaces that give these accounts rights there;
- rights from outside RBAC: a webhook authorizer;
- cloud roles tied to an account: EKS IRSA or Pod Identity, GKE or AKS Workload Identity.

So:
- Bind only the namespaces you need.
- Never bind a namespace where a controller with cluster-wide rights runs. For example:
  `argocd`, `flux-system`, `cert-manager`, `external-secrets`, ingress controllers.
  - Its service account's rights become every runbook's.
  - Check a namespace first: `kubectl get rolebindings,clusterrolebindings -A -o wide | grep NAMESPACE/`
    lists the roles of its service accounts (`NAMESPACE/NAME` in the last column).
- Never bind `kube-*` namespaces (`kube-system` and the like): their service accounts run the
  cluster. The gate refuses a session then, whatever their labels.
- Never bind `md-runbook-ops` itself. The gate refuses that too.
- The cells read every pod spec in the cluster. A credential written inline in `env` is readable
  by every runbook: use Secrets.
- **More rights:** add rules to `md-runbook-ops-operate`. Whatever it allows, every runbook on
  this host can do.
  - `pods/exec` lets a block read the token of every pod it execs into: it acts as their
    accounts.
  - `jobs create` (for `kubectl create job --from=cronjob/NAME`) is commented out in the
    manifest. It lets runbooks run pods of their own there. The policy holds them to the account
    `default`, without Secrets.

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

**Coming from 0.30.x:** as a cluster admin, apply the admission policies. Without them, sessions
refuse. With a mirror, set `repository` in the file first.

```sh
kubectl apply -f apps/ops/kubernetes/admission-policy.yaml
```

- From 0.30.0, the gate's Role also gains `list` on `serviceaccounts`. Without it, sessions
  refuse with "may not list serviceaccounts".
- For the Role, apply your own copy of `md-runbook-ops.yaml`. The stock file resets the sample
  ConfigMap (your signers, `gate.conf`) and the Deployment's `CLUSTER_NAME`.

**Coming from 0.31.x:** apply both files again, as a cluster admin.
- `admission-policy.yaml` adds the policy `md-runbook-ops-workloads` and its binding.
- Your copy of `md-runbook-ops.yaml` needs from the stock file:
  - `md-runbook-ops-operate` without `jobs create` (opt-in now);
  - the log volume's `sizeLimit`;
  - once you bind `md-runbook-ops-operate` somewhere: the ClusterRole and ClusterRoleBinding
    `md-runbook-ops-gate`. The gate reads the policy and lists the ClusterRoleBindings with
    them. Where runbooks change no workloads, you may leave them out.
- Without that ClusterRole, while runbooks may change workloads, sessions refuse with:
  - `the gate's service account can't read the admission policy md-runbook-ops-workloads`;
  - `the gate's service account may not list clusterrolebindings`.
- A binding in a `kube-*` namespace now refuses sessions: delete it.
- A binding in a namespace whose service accounts have cluster-wide bindings refuses them too.
- Keep the rules you added to `md-runbook-ops-operate` in your copy: `kubectl apply` replaces
  its rules.

**Coming from 0.32.x:** apply `admission-policy.yaml` again, as a cluster admin. With a mirror,
set `repository` in the file first.
- It adds a rule on the namespace to `md-runbook-ops-workloads`.
- Without it, while runbooks may change workloads, sessions refuse with `the admission policy
  md-runbook-ops-workloads has no rule on the namespace`.
- Your copy of `md-runbook-ops.yaml` needs nothing new. Its namespace must keep Pod Security
  `restricted`, as the stock file labels it.

### A Job per session

`gate.conf` in the cluster has `cells_runner = kubernetes-job`. For each SSH session, the gate:
1. checks its own service account: it may run Jobs here, and has none of the cells' rights;
2. checks that its namespace holds the ops host alone;
3. checks that the admission policy guards its Jobs (a dry run);
4. starts a Job of the same image, as `job_service_account` (`md-runbook-cells`);
5. checks the cells' account in the new pod:
   - in `md-runbook-ops` it can't exec into pods, read pod logs, Secrets or ConfigMaps, or
     start workloads;
   - each namespace where it may change workloads enforces Pod Security, and none is `kube-*`;
   - if it may change workloads anywhere, `md-runbook-ops-workloads` is bound;
   - no service account of such a namespace has a ClusterRoleBinding;
   - its rules let it impersonate nothing but itself and one extra (`impersonation.yaml`);
   - with `job_audit_who`, `kubectl auth whoami` in the pod shows who logged in;
6. runs the session's blocks there with `kubectl exec`;
7. deletes the Job when the session ends.

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

**Network.** The NetworkPolicies need a network plugin that enforces them. Without one they do
nothing, and nothing tells you.
- Managed clusters often don't enforce them until you turn it on:
  [GKE](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/network-policy),
  [EKS](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html)
  (the VPC CNI's `enableNetworkPolicy`),
  [AKS](https://learn.microsoft.com/en-us/azure/aks/use-network-policies) (a policy engine).
- Check it after applying `cells-egress.yaml` (below): a signed block with
  `curl -m 3 -sS http://169.254.169.254/ || echo blocked` must print `blocked`.
- Egress stays open for runbooks, unless you apply the egress policy (below).
- Some plugins also apply an `ipBlock` to pod addresses. There the Job pods can still reach
  sshd, but they have no key to log in.

**Egress (opt-in).** [kubernetes/cells-egress.yaml](kubernetes/cells-egress.yaml) lets the Job
pods reach only the cluster's DNS and the API server. It blocks:
- the cloud's metadata address (169.254.169.254), where it gives out node credentials;
- other namespaces' Services, and the pods behind them;
- the internet.

Apply it when your runbooks only use kubectl. Runbooks often call services too, such as health
checks: add a rule for each.

Before you apply it, put in your API server's address and port. The policy sees the address
behind the `kubernetes` Service:

```sh
kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o wide
# ENDPOINTS: the cidr (ADDRESS/32), one ipBlock each; PORTS: the port (often 6443)
kubectl apply -f apps/ops/kubernetes/cells-egress.yaml
```

- Some network plugins check before the Service's translation. There, add the Service's address
  too (`kubectl get service kubernetes -n default`, port 443).
- The API server's addresses can change: sessions then refuse until you update the policy.
  - On EKS, each Kubernetes version update replaces them
    ([EKS network requirements](https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html)).
    Allow your cluster subnets' CIDRs instead.
- Some plugins (k3s's, for one) drop a new pod's traffic for its first seconds. The Job's pod
  waits for the API server, up to 60 seconds, before it's ready.
- Without the right address, sessions refuse after that wait: the gate can't check the cells'
  account in the pod.
- NodeLocal DNSCache (169.254.20.10) and OpenShift's DNS run elsewhere than kube-dns pods: give
  them a rule of their own.
- On Cilium, an `ipBlock` with a node's address may need `policy-cidr-match-mode: nodes`.
  The API server often runs on the control plane nodes.

**The ops pod's egress (opt-in).** [kubernetes/ops-egress.yaml](kubernetes/ops-egress.yaml) does
the same for the ops pod. It may then reach only:
- the cluster's DNS and the API server;
- the run reports' host, if you add it (`report_to`: a commented rule).

The ops pod holds the host key and the report token. This keeps a compromised gate from sending
them elsewhere.

What still works:
- sshd's replies: a NetworkPolicy lets the replies of an allowed connection through;
- the sessions' Jobs and `kubectl exec`: both go through the API server;
- `kubectl port-forward` to sshd.

Put in your API server's address and port as for `cells-egress.yaml`, then:

```sh
kubectl apply -f apps/ops/kubernetes/ops-egress.yaml
```

- Without the right address, sessions refuse: the gate can't start their Jobs.
- The same notes as above apply: NodeLocal DNSCache, Cilium, the Service's address, addresses
  that change.

Settings in `gate.conf`:
- `job_service_account = NAME`: required.
- `job_image = IMAGE`: optional. The default is the ops pod's own image. It must be of the
  repository `admission-policy.yaml` allows.
- `job_audit_who = yes`: optional, off by default. The Kubernetes audit log names the person
  behind each block's kubectl call. Apply `kubernetes/impersonation.yaml` first
  ([how and why](../../docs/features/kubernetes.md#who-in-the-kubernetes-audit-log)).
- Outside a cluster, remove `cells_runner` and `job_service_account`.

**Your own cells' service account.** With another `job_service_account` than
`md-runbook-cells`:
- Change its name in `admission-policy.yaml` too. Else the policy refuses the cells' Job.
- Give it what the manifest gives that one:
  - `get` and `list` on `namespaces`, cluster-wide (the ClusterRole `md-runbook-ops` has them):
    the gate's namespace check needs them.
    Without them the session refuses with "can't list the namespaces".
  - `imagePullSecrets` for a private registry. The gate's Job names none, so the pod takes them
    from its service account:
    `kubectl -n md-runbook-ops patch serviceaccount NAME -p '{"imagePullSecrets":[{"name":"SECRET"}]}'`.
    This also goes for `md-runbook-cells` itself.

**Another namespace, or two ops hosts in one cluster.** The gate finds its namespace from its
pod. The admission policies name `md-runbook-ops` themselves:
- each policy's `matchConditions` (`system:serviceaccount:md-runbook-ops:…`);
- the `namespaceSelector` of the bindings `md-runbook-ops-jobs` and `md-runbook-ops-exec`;
- the namespace rule of `md-runbook-ops-workloads`.

Change each of them with the namespace. Keep the policies' names: the gate looks for them.

For a second host (say `md-runbook-ops-eu`), widen the policies rather than copying them:
- `matchConditions`: `request.userInfo.username in [...]`, with both hosts' accounts;
- the bindings: a `namespaceSelector` with both namespaces (`matchExpressions`, operator `In`);
- the namespace rule: refuse both namespaces.

Give the second host its own copy of the namespaced objects. Add its accounts as subjects to the
ClusterRoleBindings `md-runbook-ops` and `md-runbook-ops-gate`. We haven't tested two hosts in
one cluster yet.

### SSH certificates

Your CA signs short-lived certificates; this host trusts the CA. The guide:
[SSH certificates](../../docs/features/ssh-certificates.md).

Add these files to the ConfigMap `md-runbook-ops-keys`, each optional:
- `user_ca`: the CA's public key (`TrustedUserCAKeys`). Its certificates may log in.
  - List one CA, or CAs that share one name space: each CA listed may sign any key ID.
- `authorized_principals`: one principal per line (`AuthorizedPrincipalsFile`).
  - Without it, a certificate must name the principal `ops`, the account.
  - With it, it must name one of these instead. Pick a name for this host alone, such as
    `md-runbook-ops-prod`. Then a certificate your CA signs for `ops` elsewhere can't log in here.
  - Empty, or unreadable: no certificate logs in. The start says so.
- `revoked_keys`: a KRL from `ssh-keygen -k`, or public keys (`RevokedKeys`). Plain keys too.
  - Ship an empty one from the start: it revokes nothing. A later revocation then needs no
    restart.

`authorized_keys` keeps working next to them.

```sh
touch revoked_keys    # once
kubectl $ns create configmap md-runbook-ops-keys --from-file=authorized_keys \
  --from-file=user_ca --from-file=authorized_principals --from-file=revoked_keys \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl $ns rollout restart deployment/md-runbook-ops
kubectl $ns logs deployment/md-runbook-ops | grep -E 'SSH certificates|principals|revoked'
```

What the gate logs:
- `who`: the certificate's key ID, such as `alice@example.com`;
- `cert_ca`, the CA's fingerprint, on every event;
- in the session event: `cert_serial` and `key` (the key's fingerprint);
- a key ID it can't use: `who` is the key's fingerprint, and `cert_problem` says why. It takes
  printable ASCII with single spaces, at most 256 bytes, not shaped like `SHA256:…`.

sshd's own lines are in the container's output too:
- each starts with `sshd: `;
- sshd writes a key ID as it is, line breaks included. The prefix keeps such a line from passing
  for a gate event;
- `md-runbook audit` reads gate events only at a line's start, or after a time or a syslog
  header ([formats](../../docs/features/cli.md#gate-audit)).

When a change counts:
- The start script adds each sshd directive only when its file is there. Adding or removing a
  file needs a restart (`rollout restart`).
  - [sshd_config(5)](https://man.openbsd.org/sshd_config.5): with `RevokedKeys`, an unreadable
    file refuses every key. So the host doesn't start when `revoked_keys` can't be read.
- sshd reads the files at each login. A changed file counts once Kubernetes updates the mount:
  the kubelet's sync period plus its cache delay
  ([mounted ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/#mounted-configmaps-are-updated-automatically)).
- Never remove `revoked_keys` from a running host: sshd then refuses every key until a restart.
- A KRL is binary. `kubectl create configmap` keeps a file that isn't valid UTF-8 under
  `binaryData`, which the mount serves as it was.
- A revoked certificate doesn't end an open session: restart the pod.

Outside a cluster, put the same files next to `authorized_keys` in the mounted `keys` folder.

### The audit log, and a stolen key

**Ship the log off the cluster.** The gate logs each session and block to a file and to the
container's output. Each line names the key: its fingerprint, or the certificate's key ID.
- Collect the container's output with your log collector (Fluent Bit, Vector, your cloud's
  logging).
- `kubectl logs` alone isn't enough. A restarted or moved pod takes its log with it, and the
  kubelet keeps only the newest files.
- The log volume holds 256 MiB. Past that, Kubernetes evicts the pod.
- The Kubernetes audit log names the cells' account, not the person. The gate's log says which
  key ran what: keep both.
  - With `job_audit_who = yes`, audit events also carry the person, in `impersonatedUser`'s
    extra `md-runbook.dev/operator`. A block can change that value: the gate's log stays the
    authority ([details](../../docs/features/kubernetes.md#who-in-the-kubernetes-audit-log)).

**A key stolen, or someone leaving:**
1. Save the log, unless it's shipped already:
   `kubectl $ns logs deployment/md-runbook-ops > gate-$(date +%F).log`.
2. Remove their line from `authorized_keys`, then apply it:

   ```sh
   kubectl $ns create configmap md-runbook-ops-keys --from-file=authorized_keys \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

   With [SSH certificates](#ssh-certificates), list the other files too. Add their key ID or
   serial to the KRL in `revoked_keys`, or wait for their certificates to expire.

3. End open sessions: `kubectl $ns rollout restart deployment/md-runbook-ops`. A session lasts up
   to a day, and a removed key doesn't end it. Its Job goes with the old pod.
4. A signing key: remove its line from `allowed_signers`. Withdraw what it signed (`revoked` or
   `floors`, above), and sign again what you keep.
5. Look for what the key ran: its fingerprint, or the certificate's key ID, is on each line of
   the log.

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

- **kubectl** is 1.35 (`KUBECTL_VERSION`), for clusters from 1.34 to 1.36: kubectl supports one
  minor version either side ([version skew policy](https://kubernetes.io/releases/version-skew-policy/#kubectl)).
  - The build checks the download against SHA-256s written in the Dockerfile, not fetched with
    it.
- **Debian** is pinned by digest too.

### Verify the image before you deploy

Each release signs where its images and files were built (GitHub artifact attestations).

- Find the release's image digest: `docker buildx imagetools inspect ghcr.io/smojon/md-runbook-ops:0.32.0`.
  Copy the `Digest:` line (`sha256:…`).
- Check it came from md-runbook's release workflow:

  ```sh
  gh attestation verify oci://ghcr.io/smojon/md-runbook-ops@sha256:DIGEST \
    --repo smojon/md-runbook \
    --signer-workflow smojon/md-runbook/.github/workflows/release.yml
  ```

- Pin that digest in the Deployment: `image: ghcr.io/smojon/md-runbook-ops@sha256:DIGEST`.
  - A tag can be moved to other bytes; a digest can't.
  - With a mirror, the digest stays the same.
- Release files work the same way: `gh attestation verify md-runbook-gate-linux-amd64 --repo smojon/md-runbook`.

Each md-runbook release publishes the image as `ghcr.io/smojon/md-runbook-ops`. The
[Ops host workflow](../../.github/workflows/ops.yml) tests
it in a kind cluster and outside one.

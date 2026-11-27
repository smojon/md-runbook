# The ops host without an open port

Nothing in the cluster listens on the internet. A connector in the cluster dials out to a
vendor's network. Your devices dial in to that network, after the vendor's login.

What it gives:
- **No open port 22.** Scanners and password guessing can't reach sshd.
- **Fewer sshd bugs in reach.** Some need only a connection, before any login: CVE-2024-6387,
  for one ([OpenSSH 9.8 release notes](https://www.openssh.org/txt/release-9.8)).
- **The ops host works behind NAT,** and where firewalls forbid inbound load balancers.
- **The vendor's login comes first:** your identity provider, with its MFA.
- **SSH stays end to end.** Our sshd and the gate hold the keys. The vendor carries ciphertext
  only.

What it doesn't change:
- What a logged-in user can do. The gate's policy still decides.
- A stolen SSH key still logs in, from any device the vendor lets in.

This page covers two vendors: Tailscale and Cloudflare. Their docs change. Check the linked
pages before you set it up.

## Keep the vendor out of SSH

Both vendors also offer SSH of their own. Don't use it here: it replaces our keys or sees the
session.
- **Tailscale SSH:** `tailscaled` takes port 22 on the tailnet address and logs users in itself
  ([Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)). Don't run `tailscale set --ssh`.
- **Cloudflare's Access for Infrastructure:** the server trusts Cloudflare's SSH CA. Its proxy
  logs the commands users run
  ([SSH with Access for Infrastructure](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-infrastructure-access/)).

Use the vendor as a network only, as below.

## Run the connector in a namespace of its own

Put the connector in its own namespace, such as `tailscale` or `cloudflared`. Not in
`md-runbook-ops`, and not as a sidecar of the ops pod.

**In `md-runbook-ops`, the gate refuses it.** At each session, the gate checks its namespace:
- a pod that runs as another service account than `md-runbook-ops` or `md-runbook-cells`
  refuses the session;
- so does a service account other than those two and `default`.

See "A namespace of its own" in [In a cluster](../../apps/ops/README.md#in-a-cluster).

**A sidecar in the ops pod passes that check, but opens the pod's egress.**
- The sidecar shares the ops pod's network, with sshd and the gate.
- Tailscale needs outbound TCP 443 to any address: its relays have no fixed addresses
  ([firewall ports](https://tailscale.com/kb/1082/firewall-ports)).
- A NetworkPolicy can't name hosts. So `ops-egress.yaml` would have to allow port 443 to the
  whole internet.
- `ops-egress.yaml` keeps a compromised gate from sending the host key away. Keep it.
- The sidecar's state needs a Secret the ops pod can write, or a new device at each restart
  ([Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params)).

**In its own namespace, the connector passes our checks:**
- **The gate's namespace check** sees only the ops pod and its Jobs.
- **The admission policies** match only the gate's and the cells' accounts. The connector's
  pods don't run as either.
- **Pod Security** `restricted` holds `md-runbook-ops` only. The connector's namespace has its
  own level (below).
- **The NetworkPolicy** `md-runbook-ops` lets other namespaces reach sshd. Narrowed it to your
  clients? Then add the connector's namespace.
- **`ops-egress.yaml`** stays as it is: it lets the replies of allowed connections through.
- **`cells-egress.yaml`** stays too. It already keeps the Job pods from other namespaces.

**Never bind the connector's namespace for runbooks.** A runbook could then stop your access.
The gate refuses it anyway when the namespace doesn't enforce Pod Security `baseline`.

**Keep its credentials in Secrets.** The cells read every pod spec in the cluster. An auth key
or tunnel token written inline in `env` is readable by every runbook.

## Tailscale

The [Tailscale Kubernetes operator](https://tailscale.com/docs/kubernetes-operator) puts the ops
Service on your tailnet. Its proxies run in the namespace `tailscale`.

1. Install the operator with Helm, as
   [Install the operator](https://tailscale.com/docs/kubernetes-operator/install-operator) says.
   It needs an OAuth client and the tags `tag:k8s-operator` and `tag:k8s`.
2. Expose the ops Service. In your copy of `md-runbook-ops.yaml`, add to the Service:

   ```yaml
   metadata:
     annotations:
       tailscale.com/expose: "true"
       tailscale.com/hostname: md-runbook-ops
   ```

   - [Ingress](https://tailscale.com/docs/kubernetes-operator/ingress) shows this annotation, and
     `loadBalancerClass: tailscale` as the other way.
   - [Custom machine names](https://tailscale.com/docs/kubernetes-operator/manage-and-configure/custom-machine-names)
     covers `tailscale.com/hostname`.
3. Limit who reaches it. A new tailnet's policy lets every device reach every other
   ([access control](https://tailscale.com/docs/features/access-control)).
   - Write a [grant](https://tailscale.com/kb/1324/grants) from your operators to `tag:k8s`,
     with `"ip": ["tcp:22"]`.
   - Remove the allow-all rule.

**Pod Security of `tailscale`.** The operator's proxies run privileged by default: they create
a TUN device.
- So the namespace `tailscale` can't enforce `baseline` or `restricted`.
- A ProxyClass can lower that, with a device plugin
  ([RBAC and permissions](https://tailscale.com/docs/kubernetes-operator/reference/rbac)).
- Our namespace keeps `restricted`: the proxies don't run there.

**Clients:**
- **VS Code and the command line:** Tailscale on the computer. The host is the device's
  MagicDNS name, such as `md-runbook-ops.example-tailnet.ts.net`
  ([MagicDNS](https://tailscale.com/kb/1081/magicdns)). The port is 22.
- **Phones:** the Tailscale app, connected. The md-runbook app's SSH then goes through it: use
  the same host name.
- The host key stays the same: sshd keeps its own. The app's pinned key still matches.

## Cloudflare

Run `cloudflared` as a Deployment in a namespace of its own, such as `cloudflared`.
- Cloudflare's [Kubernetes guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/deployment-guides/kubernetes/)
  has the manifest. It uses the image `cloudflare/cloudflared:latest`: pin it by digest.
- The tunnel token goes in a Secret, read as `TUNNEL_TOKEN`, as in that guide.
- `cloudflared` needs outbound port 7844, TCP and UDP, to Cloudflare's listed addresses
  ([tunnel with firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)).
  Those addresses are fixed: a NetworkPolicy in its namespace can allow just them.
- `cloudflared` reaches sshd through the ops Service:
  `md-runbook-ops.md-runbook-ops.svc:22`.

Then pick one of two ways.

**A published application (computers only).**
- Route a public hostname, such as `ssh.example.com`, to the SSH service
  `md-runbook-ops.md-runbook-ops.svc:22`.
- Add an Access application with your login policy.
- Each computer needs `cloudflared`. In `~/.ssh/config`:

  ```
  Host ssh.example.com
    ProxyCommand cloudflared access ssh --hostname %h
  ```

- `cloudflared` opens a browser for the login.
- VS Code and the command line use OpenSSH, so they take this config.
- The md-runbook app on a phone has no ProxyCommand. Use the private network instead.
- Cloudflare's guide: [SSH with cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/).

**A private network (computers and phones).**
- Route only the ops Service through the tunnel: a CIDR route of its ClusterIP alone, a `/32`.
  - Not the cluster's ranges: else every enrolled device reaches every pod and Service.
  - `kubectl -n md-runbook-ops get service md-runbook-ops` shows the ClusterIP.
  - A private hostname route works too, from `cloudflared` 2025.7.0
    ([private hostname](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/)).
- Add a Gateway network policy: port 22 for your operators only. Without one, every enrolled
  device can connect.
- Devices run the Cloudflare One Client, enrolled in your organization. On phones, the app is
  Cloudflare One Agent
  ([download](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/)).
- The client's Traffic and DNS mode carries all ports and protocols
  ([client modes](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/modes/)).
  So the md-runbook app's SSH should go through it too.
- Cloudflare's guides: [SSH through the client](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-device-client/),
  [private networks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/).
- Try it from each phone system before you close the inbound path.

## Client addresses

Through a connector, sshd may see one address for every client.
- The gate's log then shows it, not the client's own.
- `from=` in `authorized_keys` can't tell clients apart.
- One client with a wrong key can lock the others out for a while (`PerSourcePenalties`).

See "Client addresses" in [In a cluster](../../apps/ops/README.md#in-a-cluster).

## Close the inbound path

Once everyone connects through the vendor:
1. Remove the LoadBalancer, or the VPN route. For a LoadBalancer, run
   `kubectl -n md-runbook-ops edit service md-runbook-ops`:
   - set `type: ClusterIP`;
   - remove each `nodePort:` line, `loadBalancerSourceRanges` and `externalTrafficPolicy`.
2. Check: `kubectl -n md-runbook-ops get service md-runbook-ops` shows `ClusterIP`, and no
   external IP.
3. Check your cloud's console: its load balancer is gone.
4. Keep the ClusterIP Service: the connector reaches sshd through it.

**If the vendor is down:**
- A cluster admin forwards a local port to sshd, with no public port:

  ```sh
  kubectl -n md-runbook-ops port-forward service/md-runbook-ops 2222:22
  ```

- Point VS Code or the command line at `localhost`, port 2222, user `ops`.
- The admission policy `md-runbook-ops-exec` holds only the gate's account. Your own
  port-forward passes.
- OpenSSH asks about the host key of `[localhost]:2222`. Compare it with the fingerprint in the
  log: `kubectl -n md-runbook-ops logs deployment/md-runbook-ops | grep 'host key'`.
- The port-forward works from computers only, not from the phone app.
- Don't keep a public port open as a fallback: it brings back what you closed.

## Without a vendor

A pairing mode for our own [relay](../../apps/relay/README.md) is on the roadmap. The ops pod and
the clients would both dial out to it. Open an issue if you need it.

# The ops host without an open port

Nothing in the cluster listens on the internet. A connector in the cluster dials out to a
vendor's network, and your devices dial in to that network. SSH stays end to end: the vendor
carries encrypted bytes only.

What it gives:
- No open port 22. Scanners, password guessing and sshd bugs before login can't reach it.
- It works behind NAT, and where firewalls forbid inbound load balancers.
- The vendor's login (SSO, MFA) comes before anyone reaches sshd.

What it doesn't change:
- What a logged-in user can do. The gate's policy still decides.
- A stolen SSH key still logs in, from any device the vendor lets in.

This page covers two vendors: Tailscale and Cloudflare. Their docs change. Check the linked
pages before you set it up.

## Keep the connector out of md-runbook-ops

Run the connector in a namespace of its own. Don't add it as a sidecar to the ops pod.
- A sidecar runs as the ops pod's service account. Tailscale keeps its state in a Secret, and
  the gate refuses an account that can read Secrets.
- The gate also refuses other apps' pods and service accounts in its namespace
  ([apps/ops/README.md](../../apps/ops/README.md)).
- The manifest's NetworkPolicy already lets other namespaces reach sshd.

## Tailscale

1. Install the [Tailscale Kubernetes operator](https://tailscale.com/kb/1185/kubernetes). Its
   proxies run in the namespace `tailscale`.
2. Expose the ops Service to your tailnet:

   ```sh
   kubectl -n md-runbook-ops annotate service md-runbook-ops \
     tailscale.com/expose=true tailscale.com/hostname=md-runbook-ops
   ```

   See [layer 3 ingress](https://tailscale.com/docs/kubernetes-operator/ingress/expose-workload-to-tailnet-l3)
   for the operator's other ways.
3. In your tailnet policy, let only your operators reach that device on port 22.

Clients:
- **VS Code and the command line:** Tailscale on the computer. The host is the tailnet name,
  such as `md-runbook-ops.example-tailnet.ts.net`.
- **Phones:** the Tailscale app, then the same host name in the md-runbook app.

## Cloudflare

Run `cloudflared` as a Deployment in a namespace of its own. Then pick one of two ways.

**A published application (computers only).**
- Route a public hostname, such as `ssh.example.com`, to the SSH service
  `md-runbook-ops.md-runbook-ops.svc:22`.
- Add an Access application with your login policy.
- On each computer, in `~/.ssh/config`:

  ```
  Host ssh.example.com
    ProxyCommand cloudflared access ssh --hostname %h
  ```

- `cloudflared` opens a browser for the login.
- VS Code and the command line use OpenSSH, so they take this config. The md-runbook app on a
  phone doesn't: use the private network instead.
- Cloudflare's guide: [SSH with cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/).

**A private network (computers and phones).**
- Route a private hostname, or the Service's address, through the tunnel.
- Devices run the Cloudflare One Client, enrolled in your organization.
- A Gateway network policy allows port 22 for your operators only. Block the rest of that
  network.
- Cloudflare's guides: [SSH through the client](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-device-client/),
  [private networks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/).
- Check there that the client routes private networks on your phones' systems.

## Close the inbound path

Once everyone connects through the vendor:
- Remove the LoadBalancer, or the VPN route.
- Keep the ClusterIP Service: the connector reaches sshd through it.

**If the vendor is down:**
- `kubectl -n md-runbook-ops port-forward service/md-runbook-ops 2222:22` reaches sshd
  with no public port.
- Don't keep a public port open as a fallback: it brings back what you closed.

## Without a vendor

A pairing mode for our own [relay](../../apps/relay/README.md) is on the roadmap: the ops pod
and the clients both dial out to it. Open an issue if you need it.

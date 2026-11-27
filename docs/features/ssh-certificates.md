# SSH certificates

A company CA signs short-lived SSH certificates. Servers trust the CA instead of each key.

## What they give

- **No key lists to keep.** The [ops host](../../apps/ops/README.md#ssh-certificates) trusts your
  CA. `authorized_keys` can stay empty.
- **Names in the audit.** The gate logs the certificate's key ID as `who`, such as
  `alice@example.com`, instead of a key fingerprint.
  - Every event adds the CA's fingerprint (`cert_ca`): the name is that CA's word.
  - The session event adds the serial (`cert_serial`) and the key (`key`).
  - The run report's `who` and `md-runbook audit --who` use the key ID too.
  - On the ops host in a cluster, `job_audit_who = yes` puts it into the Kubernetes audit log
    as well ([how](kubernetes.md#who-in-the-kubernetes-audit-log)).
- **Offboarding by expiry.** A certificate valid for 8 hours stops by itself. A KRL revokes one
  sooner.
- **Rules in the certificate.** Principals, validity, `source-address`: sshd enforces them.

## A CA by hand

```sh
# The CA. Keep its private key offline, or in a token (ssh-keygen -D).
ssh-keygen -t ed25519 -C 'example.com user CA' -f user_ca
# Alice's certificate: key ID alice@example.com, principal ops, 8 hours, serial 1001.
ssh-keygen -s user_ca -I alice@example.com -n ops -V +8h -z 1001 alice.pub
# What alice-cert.pub says:
ssh-keygen -L -f alice-cert.pub
```

- `-I`: the key ID. sshd logs it, and the gate logs it as `who`. Make it the person's own
  name, one per person (rules below).
- `-n`: the principals. On the ops host: `ops`, or a name from `authorized_principals`.
- `-V`: the validity. `+8h` is from now to 8 hours on. Without `-V`, a certificate never
  expires.
- `-z`: the serial. Give each certificate its own: a KRL can revoke by serial.

See [ssh-keygen(1), CERTIFICATES](https://man.openbsd.org/ssh-keygen.1#CERTIFICATES).

## On a server

- **The ops host:** `user_ca`, `authorized_principals` and `revoked_keys` in its ConfigMap
  ([apps/ops](../../apps/ops/README.md#ssh-certificates)).
- **Any OpenSSH server with the gate** ([apps/gate](../../apps/gate/README.md)):
  - `TrustedUserCAKeys` in `sshd_config` names the CA's public key;
  - `ExposeAuthInfo yes` lets the gate read the certificate;
  - `ForceCommand` runs the gate for every login, as on the ops host. Or put
    `command="…/md-runbook-gate"` before each principal in `AuthorizedPrincipalsFile`.
  - A certificate's own `-O force-command=` is only an extra. A certificate signed without it
    would get a shell.

The [sshd_config(5)](https://man.openbsd.org/sshd_config.5) rules that matter:
- Without `AuthorizedPrincipalsFile`, the certificate must name the account as a principal.
- With it, it must name one of the file's principals instead.
- A certificate without principals never logs in through `TrustedUserCAKeys`.
- `TrustedUserCAKeys` may list several CAs. Then each may sign any key ID: list one CA, or CAs
  that share one name space.

## Revoking: a KRL

```sh
printf '%s\n' 'serial: 1001' 'id: bob@example.com' > revoke.txt
ssh-keygen -k -f revoked_keys -s user_ca.pub revoke.txt       # a new KRL
ssh-keygen -k -u -f revoked_keys -s user_ca.pub more.txt      # add to it
ssh-keygen -Q -f revoked_keys alice-cert.pub                  # non-zero: revoked
```

- `serial:` and `id:` lines need the CA's public key (`-s`).
- `id:` revokes every certificate of that CA with that key ID.
- sshd's `RevokedKeys` takes the KRL. If sshd can't read that file, it refuses every key.
- An empty file revokes nothing. Ship one from the start: a later revocation then only changes
  its content.
- See [ssh-keygen(1), KEY REVOCATION LISTS](https://man.openbsd.org/ssh-keygen.1#KEY_REVOCATION_LISTS).

## Offboarding

1. Stop signing for the person: in your CA, its access rules, or your script.
2. Their certificates end at their expiry. With lifetimes of hours, that is usually enough.
3. Sooner: add their key ID (`id:`) to the KRL, then update the server's `revoked_keys`.
4. End open sessions: a revoked certificate doesn't end one. On the ops host, restart the pod.
5. Look for what they ran: `md-runbook audit gate.log --who alice@example.com`.

## A CA service

- [step-ca](https://smallstep.com/docs/tutorials/ssh-certificate-login/) (Smallstep):
  - `step ca init --ssh` makes a user CA. Its `ssh_user_key.pub` goes into `TrustedUserCAKeys`.
  - `step ssh certificate KEY-ID KEY-FILE` gets a certificate. Its default lifetime is 16 hours.
  - The requester names the key ID there
    ([reference](https://smallstep.com/docs/step-cli/reference/ssh/certificate/)). Check that
    your provisioner sets it from the person's verified identity. Else anyone can log in under
    another's name.
- [HashiCorp Vault's SSH secrets engine](https://developer.hashicorp.com/vault/docs/secrets/ssh/signed-ssh-certificates):
  - it signs users' keys by role, with a TTL;
  - the key ID is the token's display name by default;
  - keep `allow_user_key_ids` off, its default. Else users choose their own key ID, so their own
    name in the log ([API](https://developer.hashicorp.com/vault/api-docs/secret/ssh)).

## The key ID in the log

The CA writes the key ID: whoever runs the CA decides the names in the log. The gate uses it as
`who` only when it is:
- 1 to 256 characters of printable ASCII: letters, digits, punctuation;
- with single spaces between words, none at either end;
- not shaped like a key's fingerprint (`SHA256:…`, `MD5:…`).

Else `who` is the key's fingerprint, and the session event says why (`cert_problem`). So no line
breaks, no look-alike letters from other scripts, no invisible characters.

## Limits

- The gate's own check of the account's key lines can't see certificate principals
  ([apps/gate](../../apps/gate/README.md#all-signed-or-none)).
- sshd checks the certificate; the gate only reads it. Without `ExposeAuthInfo yes`, the gate
  can't see it.

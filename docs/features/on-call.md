# On call: from the page to the runbook

When you're paged, the runbook should be one tap away, with the service and the host already
filled in, and the run should leave a record you can show in the postmortem.

1. **The alert carries a runbook link.** Tapping it on the phone opens the runbook in the app with
   the alert's host and parameters filled in (a [runbook link](../switching.md#runbook-links)).
   Nothing runs until you tap Run.
2. **Start Incident** (⋯ More in the app, Run ▾ in VS Code) makes a dated copy for the incident:
   every run records who ran it and where, every attempt is kept, and a first note marks when it
   was detected.
3. **Add Note** records decisions and milestones (*detected*, *mitigated*, *resolved*) as you go.
4. **Export Report** is the incident record and timeline for the postmortem; **Sign Run Record**
   vouches for it; **Export Run Record (JSON)** hands it to a ticket tool.

## Making the links

`md-runbook link` prints a runbook's link, pinned to the file as it is pushed (see the
[command line](cli.md#qr-codes-and-labels) for every option):

```sh
md-runbook link runbooks/restart-api.md --host web-1 --param SERVICE=api
# mdrunbook://open?url=https%3A%2F%2Fgithub.com%2F…%2Frestart-api.md&sha256=…&host=web-1&p.SERVICE=api

md-runbook link runbooks/restart-api.md --labels hosts.csv     # one "host<TAB>link" line per row
```

In VS Code, **Share ▾ → Open in the App** copies the same link without a host or parameters.

Alerting tools fill in the host and parameters from the alert. Leave them out of the printed
link and append them in the tool's template, URL-encoded: `&host=…` names a host as the app's
**Hosts & settings** names it (a link never adds a host), and `&p.NAME=…` fills `${param:NAME}`.
A signed runbook checks each value against its signed pattern, and md-runbook-gate checks it
again on the server, so a value from an alert can't become a command.

**Which kind of link.** `mdrunbook://` links open the app directly from mail, chat and most
pager apps on a phone. Some web consoles only make `https` links clickable: there, use the web
app's address (`--web-app https://<web app>/open`), which a phone with the app installed opens
in the app once the web app's domain is set up for it. For a laptop, use VS Code links (next
section). An alert can carry both kinds, one for the phone and one for the laptop.

## On a laptop: VS Code

`md-runbook link --vscode` prints a link that opens the runbook in VS Code, with the same fields
as the app's link:

```sh
md-runbook link runbooks/restart-api.md --vscode --host web-1 --param SERVICE=api
# vscode://smojon.md-runbook/open?url=https%3A%2F%2Fgithub.com%2F…%2Frestart-api.md&sha256=…&host=web-1&p.SERVICE=api
```

Clicking it opens VS Code (the md-runbook extension must be installed):

- **Your workspace's copy** opens when a clone of the runbook's repository is open in VS Code
  and the file there is the version the link pins. If your copy differs (you edited it, or have
  another branch checked out), you choose: **Open Your Copy** or **Open the Linked Version**.
- Otherwise the runbook is **downloaded** and opens as a copy. The same link opened again (each
  click on an alert) opens that copy with its runs, as long as the runbook is unchanged.
- A link that pins another version than the one at its address is refused, as in the app. A
  runbook that is neither signed nor pinned opens with a warning.
- The link's parameters (`p.NAME=`) are filled in, and the run uses them without asking. A
  parameter the runbook doesn't use is reported, not set. `host=` names a host of the app: in
  VS Code, cells run on this machine or on their own `host=`, so it is only shown.
- **Nothing runs** until you run it.

Alert templates append `&host=…` and `&p.NAME=…` to a VS Code link as they do to an app link.
VS Code decodes a link's query once before md-runbook reads it, so a value with `&`, `=`, `#`,
`+` or `%` in it would come apart. `md-runbook link --vscode` then carries the whole app link in
one `link=` field instead. Host names, service names and GitHub addresses don't have those
characters.

## Prometheus Alertmanager

A `runbook_url` annotation, with the instance and a label as values (`urlquery` encodes them):

```yaml
groups:
  - name: api
    rules:
      - alert: ApiErrors
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 1
        annotations:
          summary: "API 5xx on {{ $labels.instance }}"
          runbook_url: 'mdrunbook://open?url=https%3A%2F%2Fgithub.com%2Facme%2Fops%2Fblob%2Fmain%2Frunbooks%2Frestart-api.md&host={{ $labels.instance | reReplaceAll ":.*" "" | urlquery }}&p.SERVICE={{ $labels.service | urlquery }}'
```

Grafana, PagerDuty's Prometheus integration and most receivers show `runbook_url` as a link.
For the laptop, add a second annotation with the VS Code link (`md-runbook link --vscode`),
for example `runbook_vscode_url`, and show it in your notification template.

## PagerDuty

Events API v2: put the link in `links`, which PagerDuty shows on the incident in its app:

```json
{
  "routing_key": "…",
  "event_action": "trigger",
  "payload": { "summary": "API 5xx on web-1", "source": "web-1", "severity": "critical" },
  "links": [
    { "href": "mdrunbook://open?url=https%3A%2F%2Fgithub.com%2Facme%2Fops%2Fblob%2Fmain%2Frunbooks%2Frestart-api.md&host=web-1&p.SERVICE=api", "text": "Runbook (md-runbook app)" },
    { "href": "vscode://smojon.md-runbook/open?url=https%3A%2F%2Fgithub.com%2Facme%2Fops%2Fblob%2Fmain%2Frunbooks%2Frestart-api.md&host=web-1&p.SERVICE=api", "text": "Runbook (VS Code)" }
  ]
}
```

## Opsgenie

An alert's `details` (shown as key/value pairs, links clickable in the Opsgenie app):

```json
{
  "message": "API 5xx on web-1",
  "details": { "runbook": "mdrunbook://open?url=https%3A%2F%2Fgithub.com%2Facme%2Fops%2Fblob%2Fmain%2Frunbooks%2Frestart-api.md&host=web-1&p.SERVICE=api" }
}
```

## Labels on machines

For people at the machine rather than on a pager: `md-runbook qr --labels hosts.csv` prints a sheet
of QR codes, one per machine, which **Scan a code** opens ([QR codes](../switching.md#qr-codes)).

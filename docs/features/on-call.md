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
in the app once the web app's domain is set up for it.

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

## PagerDuty

Events API v2: put the link in `links`, which PagerDuty shows on the incident in its app:

```json
{
  "routing_key": "…",
  "event_action": "trigger",
  "payload": { "summary": "API 5xx on web-1", "source": "web-1", "severity": "critical" },
  "links": [
    { "href": "mdrunbook://open?url=https%3A%2F%2Fgithub.com%2Facme%2Fops%2Fblob%2Fmain%2Frunbooks%2Frestart-api.md&host=web-1&p.SERVICE=api", "text": "Runbook (md-runbook app)" }
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

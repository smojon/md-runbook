# AI assistance

md-runbook can ask an AI model to explain an output, propose the next diagnostic commands, or
draft the findings of an incident. It is **off by default**: nothing from your runbooks is sent
anywhere until you choose a provider, and every send is confirmed first.

Nothing an AI writes is ever run. Suggestions arrive as [proposed cells](#proposed-cells) that
you review and approve like any other change.

## Providers

Set `mdRunbook.ai.provider`, or run any AI command and pick one when asked:

| Value | What it uses |
| --- | --- |
| `off` (default) | Nothing. The AI buttons are hidden; the commands explain how to turn it on. |
| `vscode` | VS Code's language models: GitHub Copilot or another installed model provider. VS Code asks once whether md-runbook may use them. |
| `anthropic` | The Claude API with your own API key. |

**VS Code models.** md-runbook picks a model in this order: `mdRunbook.ai.vscodeModel` (an id,
`vendor/family`, or part of the family or name), otherwise a Copilot model from the Claude
family, otherwise any Copilot model, otherwise any available model. This needs VS Code 1.90 or
later; with older versions or no model installed, md-runbook offers to switch to the Anthropic
API.

**Anthropic API.** Run **md-runbook: Set Anthropic API Key**; the key goes into the OS keychain
(VS Code SecretStorage), never into settings or files. **md-runbook: Clear Anthropic API Key**
removes it. The model is `mdRunbook.ai.anthropicModel` (default `claude-sonnet-5-5`) and answers
are capped at `mdRunbook.ai.maxTokens` tokens. Requests go straight from VS Code to
`mdRunbook.ai.anthropicBaseUrl` (default `https://api.anthropic.com`); the `HTTPS_PROXY`
environment variable is **not** used, so behind a corporate proxy point this setting at a
reachable gateway that speaks the same API. The base URL must use `https://` (`http://` only for
`localhost` / `127.0.0.1`) and must not contain `user:password@`; redirects are not followed, so
the key is never sent to another host. The key must be printable characters without spaces, and
error messages never include it (or credentials from the URL). On `api.anthropic.com`, models that support it use
the API's server-side refusal fallback; a declined request is reported as such.

## Commands

- **Explain Output** (cell `…` menu of a code cell with output, or the Command Palette): sends
  the runbook up to that cell and opens the explanation **beside** the runbook as an unsaved
  Markdown document. It is not added to the runbook; click **Insert as Note** in the
  notification to add it as a Markdown cell below the cell.
- **Suggest Next Steps** (sparkle button in the notebook toolbar, or the cell `…` menu): asks for
  up to `mdRunbook.ai.maxProposals` commands. From a cell's menu, the runbook up to that cell is
  sent and the proposals are inserted below it; from the toolbar, the whole runbook is sent and
  the proposals are appended at the end. If the model proposes nothing, you can open its answer.
- **Summarize Incident**: drafts a findings section from the runbook and its outputs and puts it
  in a Markdown cell starting with `## Findings (AI draft)` at the end of the runbook. Running it
  again replaces that cell's text. Review and edit it; it is clearly marked as a draft.

Every command shows a cancellable progress notification while the model answers.

## What is sent

The runbook as it would be saved now (including unsaved edits and outputs), prepared like this:

- outputs are [redacted](../../README.md#secret-redaction) with your redaction settings and
  stored secret values, shortened, and wrapped in markers that tell the model they are untrusted
  data;
- with `mdRunbook.ai.pseudonymize` (default on), hostnames, IPs, URLs, emails and similar names
  are replaced by stable aliases such as `host-1`. The alias table stays in VS Code's workspace
  storage on your machine; aliases in the answer are mapped back before you see it.

Before sending, md-runbook shows the provider and model, the number of characters and whether
names are pseudonymized. **Preview** opens the exact text (system prompt and runbook) in an
unsaved document; **Send** sends it. If the runbook contains lines that look like instructions
aimed at an AI (a common prompt-injection trick in logs), they are listed first and you decide
whether to continue.

The system prompt tells the model to treat outputs as data and never follow instructions in them,
never claim it ran anything, propose commands only as proposed code blocks, prefer read-only
diagnostics, and mark anything destructive with `DESTRUCTIVE:` and an explanation.

## Proposed cells

Each proposal becomes a new code cell whose fence records who proposed it and why:

````markdown
```bash proposed by=ai reason="list pods in the namespace"
kubectl get pods -n checkout
```
````

`by=` is `mdRunbook.ai.proposerName` (default `ai`). Only `sh`, `bash`, `pwsh`, `powershell` and
`cmd` blocks in the answer are used; anything else is ignored. The reason comes from the block's
info string or, failing that, from the sentence before it.

## Security defaults

Every setting defaults to the most cautious choice:

| Setting | Default | Effect |
| --- | --- | --- |
| `mdRunbook.ai.provider` | `off` | Nothing is ever sent; AI buttons are hidden. |
| `mdRunbook.ai.confirmBeforeSend` | `true` | Every send needs your confirmation, with a preview of the exact text. |
| `mdRunbook.ai.confirmOncePerSession` | `false` | Confirm every send, not just the first one per provider and session. |
| `mdRunbook.ai.pseudonymize` | `true` | Names are replaced by aliases before sending. |
| `mdRunbook.ai.maxProposals` | `3` | At most three proposed cells per request. |

Suggestions are always inserted as proposed cells; there is no option to insert runnable cells or
to run anything automatically. Outputs are redacted with the same settings as when saving, and
stored secret values are always redacted.

## Other settings

| Setting | Default | |
| --- | --- | --- |
| `mdRunbook.ai.vscodeModel` | empty | Preferred VS Code model (see above). |
| `mdRunbook.ai.anthropicModel` | `claude-sonnet-5-5` | Claude model for the `anthropic` provider. |
| `mdRunbook.ai.anthropicBaseUrl` | `https://api.anthropic.com` | API or gateway base URL. |
| `mdRunbook.ai.maxTokens` | `4096` | Answer length cap for the `anthropic` provider (includes the model's thinking). A cut-off answer says so. |
| `mdRunbook.ai.proposerName` | `ai` | `by=` written into proposed cells. |

Limits:

- Answers can be wrong. Explanations and findings are drafts; proposals need your review.
- The VS Code provider sends the system prompt as the first user message, because the Language
  Model API has no system role.
- Very large runbooks are shortened (long outputs first) before sending.

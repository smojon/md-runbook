/**
 * Notifications after a run (`--notify`, `MD_RUNBOOK_NOTIFY_URL`): a short summary posted to a
 * chat webhook (Slack, Microsoft Teams Workflows, Discord, Google Chat, or any URL that takes
 * `{"text": …}`). The URL is a secret: it is never printed.
 */

import type { RunSummary, StepResult } from './run';

export type NotifyOn = 'failure' | 'always';

export interface NotifyConfig {
  url: string;
  on: NotifyOn;
}

/** The notification settings from the options and environment, or an error message. */
export function notifyConfig(url: string | undefined, on: string | undefined): NotifyConfig | undefined | string {
  const u = url?.trim();
  if (!u) return undefined;
  const when = (on?.trim() || 'failure').toLowerCase();
  if (when !== 'failure' && when !== 'always') return `notify-on must be "failure" or "always", not "${on}"`;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return 'the notification URL is not a valid URL';
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return 'the notification URL must use https';
  return { url: u, on: when };
}

/** Where the run can be seen, on GitHub Actions. */
export function runLink(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
}

const describe = (s: StepResult): string => `Step ${s.step} (line ${s.line}) ${s.status === 'failed' ? 'failed' : 'was not run'}${s.message ? `: ${s.message}` : ''}`;

/** The message text: one line for the result, one per failed step, and the link to the run. */
export function notifyText(file: string, summary: Pick<RunSummary, 'steps' | 'ok'>, link?: string): string {
  const total = summary.steps.length;
  const bad = summary.steps.filter((s) => s.status === 'failed' || s.status === 'not run');
  const head = summary.ok ? `✓ ${file}: all ${total} step${total === 1 ? '' : 's'} passed` : `✗ ${file}: ${bad.length} of ${total} steps failed or did not run`;
  const lines = [head, ...bad.filter((s) => s.status === 'failed' || s.message !== 'an earlier step failed').slice(0, 5).map((s) => `• ${describe(s)}`)];
  if (link) lines.push(link);
  return lines.join('\n');
}

/** The request body each service expects, chosen by the webhook's host. */
export function notifyPayload(url: string, text: string): unknown {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com') return { content: text.slice(0, 2000) };
  // Teams "Workflows" webhooks (the replacement for Office 365 connectors) take an Adaptive Card.
  if (host.endsWith('.logic.azure.com') || host.endsWith('.powerplatform.com') || host.endsWith('.webhook.office.com')) {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: text.split('\n').map((line, i) => ({ type: 'TextBlock', text: line, wrap: true, ...(i === 0 ? { weight: 'Bolder' } : {}) })),
          },
        },
      ],
    };
  }
  return { text };
}

/** Post the notification. Rejects with a message that never contains the URL. */
export async function sendNotification(url: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notifyPayload(url, text)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === 'TimeoutError' ? 'no answer within 15 s' : 'the request failed';
    throw new Error(`could not send the notification (${why})`);
  }
  if (!res.ok) throw new Error(`could not send the notification (HTTP ${res.status})`);
}

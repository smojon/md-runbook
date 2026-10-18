/**
 * Claude Messages API request body and server-sent-event stream parsing. Pure: the HTTP call
 * itself lives in src/ai/providers.ts.
 */

export const ANTHROPIC_VERSION = '2023-06-01';
/** Server-side refusal fallback: only on the first-party API and for models that accept it. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export interface AnthropicRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function anthropicRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  system: string,
  user: string,
  fallback = true,
): AnthropicRequest {
  const base = (baseUrl.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.max(1, Math.floor(maxTokens)),
    system,
    messages: [{ role: 'user', content: user }],
    stream: true,
  };
  if (fallback && base === 'https://api.anthropic.com' && FALLBACK_MODELS.test(model)) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    body.fallbacks = 'default';
  }
  return { url: `${base}/v1/messages`, headers, body };
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental SSE parser: feed decoded text chunks, get complete events back. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  feed(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      // A lone trailing CR may be the first half of CRLF: wait for more.
      if (!m || (m[0] === '\r' && m.index === this.buf.length - 1)) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}

export interface StreamUpdate {
  text?: string;
  stopReason?: string;
  error?: string;
}

/** What one Messages API stream event means for us; thinking and other blocks are ignored. */
export function interpretEvent(ev: SseEvent): StreamUpdate {
  let data: Record<string, any>;
  try {
    data = JSON.parse(ev.data) as Record<string, any>;
  } catch {
    return {};
  }
  switch (data.type) {
    case 'content_block_delta':
      return data.delta?.type === 'text_delta' && typeof data.delta.text === 'string' ? { text: data.delta.text } : {};
    case 'message_delta':
      return typeof data.delta?.stop_reason === 'string' ? { stopReason: data.delta.stop_reason } : {};
    case 'error':
      return { error: errorMessage(data) };
    default:
      return {};
  }
}

/** `{type:"error", error:{type, message}}` → readable text. */
export function errorMessage(body: unknown): string {
  const e = (body as { error?: { type?: string; message?: string } } | undefined)?.error;
  if (!e) return typeof body === 'string' ? body : 'unknown error';
  return [e.type, e.message].filter(Boolean).join(': ');
}

/** User-facing explanation of an HTTP error status from the Messages API. */
export function describeHttpError(status: number, detail: string, model: string): string {
  const d = detail ? ` (${detail})` : '';
  switch (status) {
    case 401:
      return `the Anthropic API key was rejected${d}. Run "md-runbook: Set Anthropic API Key" to replace it.`;
    case 403:
      return `the API key is not allowed to use this model or feature${d}.`;
    case 404:
      return `model "${model}" was not found${d}. Check mdRunbook.ai.anthropicModel.`;
    case 413:
      return `the runbook is too large for one request${d}.`;
    case 429:
      return `rate limited by the Anthropic API${d}. Try again in a moment.`;
    case 529:
      return `the Anthropic API is overloaded${d}. Try again in a moment.`;
    default:
      return status >= 500 ? `the Anthropic API had an internal error (${status})${d}. Try again.` : `request failed with HTTP ${status}${d}.`;
  }
}

/**
 * AI providers: VS Code's Language Model API (Copilot and other installed models) and the Claude
 * Messages API with the user's own key. Tests swap in a fake via `mdRunbook._ai.useFakeProvider`.
 */

import * as vscode from 'vscode';
import { SECTION } from '../config';
import {
  SseParser,
  anthropicRequest,
  baseUrlProblem,
  describeHttpError,
  errorMessage,
  interpretEvent,
  isValidApiKey,
  urlForDisplay,
} from '@md-runbook/core/anthropicStream';

export const ANTHROPIC_KEY = 'mdRunbook.ai.anthropicKey';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export interface AiProvider {
  readonly id: string;
  /** Provider and model, e.g. `VS Code: copilot/claude-sonnet`; final after `available()`. */
  readonly label: string;
  available(): Promise<boolean>;
  complete(system: string, user: string, token: vscode.CancellationToken, onText?: (chunk: string) => void): Promise<string>;
}

/** An error whose message is meant for the user as is. */
export class AiError extends Error {}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

// --- VS Code Language Model API ------------------------------------------------------------
// @types/vscode 1.85 predates vscode.lm (1.90), so the few members used are declared here and
// everything is feature-detected at runtime.

interface LmChatModel {
  id: string;
  vendor: string;
  family: string;
  name?: string;
  sendRequest(messages: unknown[], options?: object, token?: vscode.CancellationToken): Thenable<{ text: AsyncIterable<string> }>;
}
interface LmApi {
  selectChatModels(selector?: object): Thenable<LmChatModel[]>;
}
interface LmMessageCtor {
  User(content: string): unknown;
}

const lmApi = (): LmApi | undefined => (vscode as unknown as { lm?: LmApi }).lm;
const lmMessage = (): LmMessageCtor | undefined => (vscode as unknown as { LanguageModelChatMessage?: LmMessageCtor }).LanguageModelChatMessage;

/** Preferred model: the setting (id, family or name substring), else Copilot Claude, else Copilot, else any. */
export function pickModel(models: LmChatModel[], preference: string): LmChatModel | undefined {
  const pref = preference.trim().toLowerCase();
  if (pref) {
    const hit = models.find((m) => m.id.toLowerCase() === pref) ??
      models.find((m) => `${m.vendor}/${m.family}`.toLowerCase() === pref) ??
      models.find((m) => m.family.toLowerCase().includes(pref) || (m.name ?? '').toLowerCase().includes(pref));
    if (hit) return hit;
  }
  const copilot = models.filter((m) => m.vendor === 'copilot');
  return copilot.find((m) => /claude/i.test(m.family)) ?? copilot[0] ?? models[0];
}

class VsCodeProvider implements AiProvider {
  readonly id = 'vscode';
  private model: LmChatModel | undefined;

  get label(): string {
    return this.model ? `VS Code language model ${this.model.vendor}/${this.model.family}` : 'VS Code language model';
  }

  async available(): Promise<boolean> {
    const lm = lmApi();
    if (!lm || !lmMessage()) return false;
    try {
      this.model = pickModel(await lm.selectChatModels(), cfg().get<string>('ai.vscodeModel', ''));
    } catch {
      this.model = undefined;
    }
    return this.model !== undefined;
  }

  async complete(system: string, user: string, token: vscode.CancellationToken, onText?: (chunk: string) => void): Promise<string> {
    const Msg = lmMessage();
    if (!this.model || !Msg) throw new AiError('no VS Code language model is available.');
    // The LM API has no system role: the contract goes first, in its own message.
    const messages = [Msg.User(system), Msg.User(user)];
    let text = '';
    try {
      const res = await this.model.sendRequest(messages, { justification: 'md-runbook sends the runbook you selected so the model can explain it or propose next steps.' }, token);
      for await (const chunk of res.text) {
        if (token.isCancellationRequested) break;
        text += chunk;
        onText?.(chunk);
      }
    } catch (e) {
      throw new AiError(lmErrorMessage(e));
    }
    return text;
  }
}

function lmErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string; name?: string } | undefined;
  const code = err?.code ?? '';
  const msg = err?.message ?? String(e);
  if (/NoPermissions/i.test(code)) return 'you have not allowed md-runbook to use this language model. Run the command again and choose Allow when VS Code asks.';
  if (/Blocked/i.test(code)) return `the language model blocked the request (quota or rate limit?): ${msg}`;
  if (/NotFound/i.test(code)) return `the language model is no longer available: ${msg}. Check mdRunbook.ai.vscodeModel.`;
  if (/off_topic|filtered/i.test(msg)) return `the language model refused the request: ${msg}`;
  return `language model request failed: ${msg}`;
}

// --- Claude Messages API ----------------------------------------------------------------------

class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private model(): string {
    return cfg().get<string>('ai.anthropicModel', DEFAULT_ANTHROPIC_MODEL).trim() || DEFAULT_ANTHROPIC_MODEL;
  }

  get label(): string {
    return `Anthropic API ${this.model()}`;
  }

  async available(): Promise<boolean> {
    return !!(await this.secrets.get(ANTHROPIC_KEY));
  }

  async complete(system: string, user: string, token: vscode.CancellationToken, onText?: (chunk: string) => void): Promise<string> {
    const key = await this.secrets.get(ANTHROPIC_KEY);
    if (!key) throw new AiError('no Anthropic API key is set. Run "md-runbook: Set Anthropic API Key".');
    const model = this.model();
    const base = cfg().get<string>('ai.anthropicBaseUrl', 'https://api.anthropic.com');
    if (!isValidApiKey(key)) throw new AiError('the stored Anthropic API key is not valid. Run "md-runbook: Set Anthropic API Key" again.');
    const problem = baseUrlProblem(base);
    if (problem) throw new AiError(problem);
    const shown = urlForDisplay(base.trim() || 'https://api.anthropic.com');
    const maxTokens = cfg().get<number>('ai.maxTokens', 4096);
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      let res = await this.post(anthropicRequest(base, key, model, maxTokens, system, user), abort.signal);
      if (res.status === 400) {
        // A gateway or account may not accept the refusal-fallback beta: retry once without it.
        const detail = await res.text();
        if (!/fallback/i.test(detail)) throw new AiError(describeHttpError(400, detailOf(detail), model));
        res = await this.post(anthropicRequest(base, key, model, maxTokens, system, user, false), abort.signal);
      }
      if (!res.ok) throw new AiError(describeHttpError(res.status, detailOf(await res.text()), model));
      if (!res.body) throw new AiError('the Anthropic API returned an empty response.');
      return await readStream(res.body, token, onText);
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (token.isCancellationRequested) return '';
      // Never include the raw error message: fetch/undici errors can quote header values (the key).
      const cause = (e as { cause?: { code?: unknown } }).cause?.code;
      const code = typeof cause === 'string' && /^[A-Z0-9_]+$/.test(cause) ? ` (${cause})` : '';
      throw new AiError(`could not reach ${shown}${code}. Behind a proxy, set mdRunbook.ai.anthropicBaseUrl to a reachable gateway.`);
    } finally {
      sub.dispose();
    }
  }

  private post(req: ReturnType<typeof anthropicRequest>, signal: AbortSignal): Promise<Response> {
    // redirect: 'error': the x-api-key header must never follow a redirect to another origin.
    return fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal, redirect: 'error' });
  }
}

function detailOf(body: string): string {
  try {
    return errorMessage(JSON.parse(body));
  } catch {
    return body.slice(0, 200);
  }
}

async function readStream(body: ReadableStream<Uint8Array>, token: vscode.CancellationToken, onText?: (chunk: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = '';
  let stop: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || token.isCancellationRequested) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
      const u = interpretEvent(ev);
      if (u.error) throw new AiError(`the Anthropic API reported an error: ${u.error}`);
      if (u.stopReason) stop = u.stopReason;
      if (u.text) {
        text += u.text;
        onText?.(u.text);
      }
    }
  }
  if (stop === 'refusal') throw new AiError('the model declined this request.');
  if (stop === 'max_tokens') text += '\n\n*[Answer cut off: raise `mdRunbook.ai.maxTokens`.]*';
  return text;
}

// --- Fake provider for tests --------------------------------------------------------------------

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly label = 'fake test provider';
  /** Last prompt received, for tests. */
  last: { system: string; user: string } | undefined;

  constructor(private readonly answer: string) {}

  async available(): Promise<boolean> {
    return true;
  }

  async complete(system: string, user: string, _token: vscode.CancellationToken, onText?: (chunk: string) => void): Promise<string> {
    this.last = { system, user };
    onText?.(this.answer);
    return this.answer;
  }
}

let fake: FakeProvider | undefined;

/** Hidden test hook: a canned answer for every request (undefined = back to the real providers). */
export function useFakeProvider(answer?: string): void {
  fake = answer === undefined ? undefined : new FakeProvider(answer);
}

export function fakeLastPrompt(): { system: string; user: string } | undefined {
  return fake?.last;
}

export type ProviderSetting = 'off' | 'vscode' | 'anthropic';

export function providerSetting(): ProviderSetting {
  const v = cfg().get<string>('ai.provider', 'off');
  return v === 'vscode' || v === 'anthropic' ? v : 'off';
}

export function createProvider(id: 'vscode' | 'anthropic', secrets: vscode.SecretStorage): AiProvider {
  return id === 'vscode' ? new VsCodeProvider() : new AnthropicProvider(secrets);
}

/** The test fake, if one is installed. */
export function fakeProvider(): AiProvider | undefined {
  return fake;
}

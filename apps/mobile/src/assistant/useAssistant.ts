/**
 * The assistant's actions for one runbook, as the extension has them: Explain Output, Suggest Next
 * Steps, Summarize Incident (Claude, the user's key), Copy for AI / Paste AI Proposal (any chat
 * assistant, through the clipboard) and Check for Leaks. Every send is confirmed first; answers
 * are mapped back to the real names; suggestions arrive as proposed cells.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { parse } from '@md-runbook/core';
import { AiPrompt, explainOutputPrompt, suggestNextStepsPrompt, summarizeIncidentPrompt } from '@md-runbook/core/aiPrompt';
import { PseudonymMap, depseudonymize } from '@md-runbook/core/aiContext';
import { scanForLeaks } from '@md-runbook/core/leaks';
import { t } from '../i18n';
import { Runbook, getRunbook, updateRunbookText } from '../runbooks/store';
import { AssistantStep } from './AssistantSheet';
import { PROVIDER_LABEL, askClaude, clearApiKey, hasApiKey, setApiKey } from './claude';
import { copyText, prepareContext, pseudonymMap } from './context';
import { insertNote, insertPasted, insertSuggestions, withFindings } from './edits';

export type AskKind = 'explain' | 'suggest' | 'summarize';

/** Code cells up to and including `index` (parsed indexes): the context of a cell's question. */
function cellsUpTo(text: string, index: number): number[] {
  return parse(text)
    .cells.map((c, i) => (c.kind === 'code' && i <= index ? i : -1))
    .filter((i) => i >= 0);
}

export function useAssistant(runbook: Runbook | undefined, notify: (message: string | undefined) => void) {
  const [step, setStep] = useState<AssistantStep | undefined>();
  const [hasKey, setHasKey] = useState(false);
  /** What Send (or saving the key) goes on with. */
  const next = useRef<(() => void) | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const lastExplain = useRef<{ cell: number; label: string; text: string } | undefined>(undefined);

  useEffect(() => {
    void hasApiKey().then(setHasKey);
  }, []);

  const latest = (): string | undefined => (runbook ? (getRunbook(runbook.id)?.text ?? runbook.text) : undefined);
  const close = (): void => {
    abort.current?.abort();
    abort.current = undefined;
    next.current = undefined;
    setStep(undefined);
  };

  const ask = async (kind: AskKind, cell?: number): Promise<void> => {
    const text = latest();
    if (!runbook || text === undefined) return;
    if (!(await hasApiKey())) {
      next.current = () => void ask(kind, cell);
      return setStep({ kind: 'key' });
    }
    const label = cell === undefined ? '' : `cell ${cell + 1}`;
    const ctx = await prepareContext(text, runbook.title, cell === undefined ? undefined : cellsUpTo(text, cell));
    const prompt: AiPrompt =
      kind === 'explain'
        ? explainOutputPrompt(ctx.text, label)
        : kind === 'suggest'
          ? suggestNextStepsPrompt(ctx.text, 3, cell === undefined ? undefined : label)
          : summarizeIncidentPrompt(ctx.text);
    const what = kind === 'explain' ? t.aiWhatExplain(label) : kind === 'suggest' ? t.aiWhatSuggest : t.aiWhatSummary;
    next.current = () => void send(kind, cell, label, prompt, what, ctx.map);
    setStep({
      kind: 'confirm',
      what,
      chars: prompt.system.length + prompt.user.length,
      text: `${prompt.system}\n\n---\n\n${prompt.user}`,
      leaks: ctx.leaks,
      warnings: ctx.warnings,
      send: t.aiSend,
    });
  };

  const send = async (
    kind: AskKind,
    cell: number | undefined,
    label: string,
    prompt: AiPrompt,
    what: string,
    map: PseudonymMap,
  ): Promise<void> => {
    const ac = new AbortController();
    abort.current = ac;
    setStep({ kind: 'busy', what });
    let answer: string;
    try {
      answer = await askClaude(prompt.system, prompt.user, ac.signal);
    } catch (e) {
      if (ac.signal.aborted) return;
      setStep(undefined);
      return notify(t.aiFailed(e instanceof Error ? e.message : String(e)));
    }
    if (ac.signal.aborted || !runbook) return;
    abort.current = undefined;
    if (answer.trim() === '') {
      setStep(undefined);
      return notify(t.aiEmpty);
    }
    const now = latest() ?? '';
    if (kind === 'explain') {
      const text = depseudonymize(answer, map).trim();
      lastExplain.current = { cell: cell ?? 0, label, text };
      return setStep({ kind: 'answer', title: t.aiExplanationTitle(label), markdown: text, canInsert: true });
    }
    setStep(undefined);
    if (kind === 'suggest') {
      const r = insertSuggestions(now, answer, map, 3, cell);
      if (r.count > 0) updateRunbookText(runbook.id, r.text);
      return notify(t.aiSuggested(r.count));
    }
    updateRunbookText(runbook.id, withFindings(now, depseudonymize(answer, map), PROVIDER_LABEL));
    notify(t.aiFindingsDone);
  };

  const copyForAi = async (cell?: number): Promise<void> => {
    const text = latest();
    if (!runbook || text === undefined) return;
    const ctx = await prepareContext(text, runbook.title, cell === undefined ? undefined : [cell]);
    const out = copyText(ctx);
    const copy = async (): Promise<void> => {
      await Clipboard.setStringAsync(out);
      setStep(undefined);
      notify(t.copiedForAi(out.length));
    };
    // As sharing anywhere: the leak check first, and a look at what would be copied.
    if (ctx.leaks.length === 0) return copy();
    next.current = () => void copy();
    setStep({
      kind: 'confirm',
      what: t.actions.copyForAi[0],
      chars: out.length,
      text: out,
      leaks: ctx.leaks,
      warnings: ctx.warnings,
      send: t.aiCopy,
    });
  };

  const paste = async (after?: number): Promise<void> => {
    const text = latest();
    if (!runbook || text === undefined) return;
    const r = insertPasted(text, await Clipboard.getStringAsync(), await pseudonymMap(), after);
    if (r.count === 0) return notify(t.pastedNone);
    updateRunbookText(runbook.id, r.text);
    notify(t.pasted(r.count));
  };

  const checkLeaks = (): void => {
    const text = latest();
    if (text !== undefined) setStep({ kind: 'leaks', leaks: scanForLeaks(text) });
  };

  const sheet = {
    step,
    onKey: (key: string) => {
      void setApiKey(key).then(
        () => {
          setHasKey(true);
          const go = next.current;
          next.current = undefined;
          setStep(undefined);
          go?.();
        },
        (e: unknown) => notify(t.aiFailed(e instanceof Error ? e.message : String(e))),
      );
    },
    onSend: () => {
      const go = next.current;
      next.current = undefined;
      go?.();
    },
    onInsert: () => {
      const e = lastExplain.current;
      const text = latest();
      if (runbook && e && text !== undefined) updateRunbookText(runbook.id, insertNote(text, e.cell, e.label, PROVIDER_LABEL, e.text));
      setStep(undefined);
    },
    onClose: close,
  };

  return {
    sheet,
    hasKey,
    ask: (kind: AskKind, cell?: number) => void ask(kind, cell),
    copyForAi: (cell?: number) => void copyForAi(cell),
    paste: (after?: number) => void paste(after),
    checkLeaks,
    setKey: () => {
      next.current = undefined;
      setStep({ kind: 'key' });
    },
    clearKey: () => {
      void clearApiKey().then(() => {
        setHasKey(false);
        notify(t.aiKeyCleared);
      });
    },
  };
}

/**
 * The assistant's actions for one runbook, as the extension has them: Explain Output, Suggest Next
 * Steps, Suggest a Fix (a failed step), Summarize Incident (Claude, the user's key), Copy for AI / Paste AI Proposal (any chat
 * assistant, through the clipboard) and Check for Leaks. Every send is confirmed first; answers
 * are mapped back to the real names; suggestions arrive as proposed cells.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { parse } from '@md-runbook/core';
import {
  AiPrompt,
  explainLinePrompt,
  explainOutputPrompt,
  suggestFixPrompt,
  suggestNextStepsPrompt,
  summarizeIncidentPrompt,
} from '@md-runbook/core/aiPrompt';
import { PseudonymMap, depseudonymize } from '@md-runbook/core/aiContext';
import { scanForLeaks } from '@md-runbook/core/leaks';
import { t } from '../i18n';
import { CellRef, cellRef, resolveCell } from '../runbooks/cellRef';
import { Runbook, getRunbook, updateRunbookText } from '../runbooks/store';
import { AssistantStep } from './AssistantSheet';
import { PROVIDER_LABEL, askClaude, clearApiKey, hasApiKey, setApiKey } from './claude';
import { copyText, prepareContext, pseudonymMap } from './context';
import { insertNote, insertPasted, insertSuggestions, withFindings } from './edits';

export type AskKind = 'explain' | 'explainLine' | 'suggest' | 'fix' | 'summarize';

/** How many proposals Suggest Next Steps inserts; Suggest a Fix at most 2 (as the extension's). */
const MAX_PROPOSALS = 3;
const MAX_FIXES = Math.min(2, MAX_PROPOSALS);

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
  const lastExplain = useRef<{ cell?: CellRef; label: string; text: string } | undefined>(undefined);

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

  /**
   * Where the cell of `ref` is in `text`, or undefined; `false` (said in the notice) when it
   * changed or went since it was asked about: an answer lands next to that cell or nowhere.
   */
  const placeOf = (text: string, ref: CellRef | undefined): number | undefined | false => {
    if (!ref) return undefined;
    const at = resolveCell(text, ref);
    if (at !== undefined) return at;
    notify(t.cellNotActed);
    return false;
  };

  /** `lines`: for explainLine, the command's lines as shown ("3" or "3-5"). `at`: the cell's place in the runbook as it is now. */
  const ask = (kind: AskKind, at?: number, lines?: string): Promise<void> => {
    const text = latest();
    return askAbout(kind, text === undefined || at === undefined ? undefined : cellRef(text, at), lines);
  };

  const askAbout = async (kind: AskKind, ref: CellRef | undefined, lines?: string): Promise<void> => {
    const text = latest();
    if (!runbook || text === undefined) return;
    if (!(await hasApiKey())) {
      next.current = () => void askAbout(kind, ref, lines);
      return setStep({ kind: 'key' });
    }
    const cell = placeOf(text, ref);
    if (cell === false) return;
    const label = cell === undefined ? '' : `cell ${cell + 1}`;
    const ctx = await prepareContext(text, runbook.title, cell === undefined ? undefined : cellsUpTo(text, cell));
    const prompt: AiPrompt =
      kind === 'explain'
        ? explainOutputPrompt(ctx.text, label)
        : kind === 'explainLine'
          ? explainLinePrompt(ctx.text, label, lines ?? '1')
          : kind === 'suggest'
            ? suggestNextStepsPrompt(ctx.text, MAX_PROPOSALS, cell === undefined ? undefined : label)
            : kind === 'fix'
              ? suggestFixPrompt(ctx.text, label || 'the last step that ran', MAX_FIXES)
              : summarizeIncidentPrompt(ctx.text);
    // What the sheet calls it: "cell 3", or "line 2 of cell 3".
    const shown = kind === 'explainLine' ? t.lineOf(lines ?? '1', label) : label;
    const what =
      kind === 'explain' || kind === 'explainLine'
        ? t.aiWhatExplain(shown)
        : kind === 'suggest'
          ? t.aiWhatSuggest
          : kind === 'fix'
            ? t.aiWhatFix(shown)
            : t.aiWhatSummary;
    next.current = () => void send(kind, ref, shown, prompt, what, ctx.map);
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
    ref: CellRef | undefined,
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
    if (kind === 'explainLine') {
      const text = depseudonymize(answer, map).trim();
      // As in the extension: shown, not added to the runbook.
      return setStep({ kind: 'answer', title: t.aiExplanationTitle(label), markdown: text, canInsert: false });
    }
    if (kind === 'explain') {
      const text = depseudonymize(answer, map).trim();
      lastExplain.current = { ...(ref ? { cell: ref } : {}), label, text };
      return setStep({ kind: 'answer', title: t.aiExplanationTitle(label), markdown: text, canInsert: true });
    }
    setStep(undefined);
    if (kind === 'suggest' || kind === 'fix') {
      // A fix goes right after the failed step, as a proposal to approve (the extension's
      // proposeAfter): that step wherever it is now, after the answer's wait; nowhere if it went.
      const cell = placeOf(now, ref);
      if (cell === false) return;
      const r = insertSuggestions(now, answer, map, kind === 'fix' ? MAX_FIXES : MAX_PROPOSALS, cell);
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
    const before = latest();
    if (!runbook || before === undefined) return;
    const ref = after === undefined ? undefined : cellRef(before, after);
    const clipboard = await Clipboard.getStringAsync();
    const map = await pseudonymMap();
    // The text and the cell as they are after the wait: nothing written over, nothing put elsewhere.
    const text = latest() ?? before;
    const at = placeOf(text, ref);
    if (at === false) return;
    const r = insertPasted(text, clipboard, map, at);
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
      setStep(undefined);
      if (!runbook || !e || text === undefined) return;
      // After the cell explained, wherever it is now; nowhere if it changed or went.
      const at = placeOf(text, e.cell);
      if (at !== false) updateRunbookText(runbook.id, insertNote(text, at ?? 0, e.label, PROVIDER_LABEL, e.text));
    },
    onClose: close,
  };

  return {
    sheet,
    hasKey,
    ask: (kind: AskKind, cell?: number, lines?: string) => void ask(kind, cell, lines),
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

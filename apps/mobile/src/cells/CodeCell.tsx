/**
 * A code cell drawn like a VS Code notebook cell: the cell's ▶ (or Stop while it runs) and its
 * last result in the left gutter, the source with syntax colours, a tap on a line opens that
 * command's actions (Run line, Run lines 1-N, Run lines N-end, Check), checked commands get a
 * mark beside them, a status line (checked-lines run, language and options) and the output.
 */
import { ParsedCell, isCodeMeta, outputSummary, parseLineSet, shellKindForLanguage } from '@md-runbook/core';
import { OutputText } from './OutputText';
import { CloudView } from './CloudView';
import { cloudView } from '@md-runbook/core/cloudViews';
import { useOutputSettings } from '../settings/store';
import type { RemotePlatform } from '@md-runbook/ssh';
import { LineStep, stepAtLine } from '@md-runbook/core/steps';
import { ReactNode, memo, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Token, highlightBash } from '../highlight/bash';
import { t } from '../i18n';
import { formatWait, runnability } from '../ssh/cells';
import { LineMode, cellSteps, lineLabel } from '../ssh/lineRuns';
import { Palette, mono, themedStyles, usePalette } from '../theme';
import { Codicon, CodiconName } from '../ui/Codicon';

export interface CellRun {
  live: string;
  /** Lines (0-based) of the command running now, in a line run. */
  step?: { start: number; end: number };
  /** Step through, waiting before this command. */
  paused?: { step: { start: number; end: number }; next(): void; cont(): void };
  /** retry=: the attempt running, or (with `waitMs`) the one that failed while the next waits. */
  attempt?: { n: number; of: number; waitMs?: number };
}

export interface CodeCellProps {
  cell: ParsedCell;
  index: number;
  /** The runbook it is in, as approvals know it (core approvalScope): approvals made on this device count. */
  runbookId?: string;
  /** What the selected host runs, once known (Windows servers run PowerShell and cmd cells). */
  platform?: RemotePlatform;
  /** Commands (their first line) with a breakpoint: a run of the cell pauses before them. */
  breakpoints?: ReadonlySet<number>;
  onToggleBreakpoint?(step: LineStep): void;
  /** The assistant explains one command (shown when there is an assistant). */
  onExplainLine?(step: LineStep): void;
  /** Shown under the cell (the approval card of a proposal). */
  below?: ReactNode;
  /** A host is chosen: runs are possible. */
  canRun: boolean;
  running: CellRun | undefined;
  /** Another cell is running. */
  busy: boolean;
  /** Texts of the checked commands. */
  checked: ReadonlySet<string>;
  onRun(mode?: LineMode, line?: number): void;
  onStop(): void;
  onToggleCheck(step: LineStep): void;
  /** The cell's own actions (⋯ on its status line, or a long press). */
  onActions?(): void;
}

export const CodeCell = memo(function CodeCell(p: CodeCellProps) {
  const { cell, index, running } = p;
  const styles = useStyles();
  const c = usePalette();
  const can = runnability(cell, p.runbookId, p.platform);
  const isBash = cell.kind === 'code' && shellKindForLanguage(cell.languageId) === 'bash';
  // AWS / Google Cloud JSON in the saved output (without its stderr lines): a list with console links.
  const showCloud = useOutputSettings().cloudViews;
  const saved = cell.output;
  const cloud = useMemo(() => {
    if (!showCloud || !saved) return undefined;
    const errLines = parseLineSet(saved.attrs.stderr);
    return cloudView(
      saved.text
        .split('\n')
        .filter((_, i) => !errLines.has(i))
        .join('\n'),
    );
  }, [showCloud, saved]);
  const lines = useMemo(
    () => (isBash ? highlightBash(cell.value) : cell.value.split('\n').map((l): Token[] => [{ text: l, kind: 'plain' }])),
    [cell.value, isBash],
  );
  const shell = can.ok ? can.shell : undefined;
  // The React Compiler memoizes this (a manual useMemo over the union-typed verdict confuses it).
  const steps = shell === undefined ? [] : cellSteps(cell.value, shell);
  const [selected, setSelected] = useState<LineStep | undefined>();
  // The selection is a command of the current text (an edit may have moved it).
  const sel = selected && steps.find((s) => s.start === selected.start && s.text === selected.text);
  const checkedSteps = steps.filter((s) => p.checked.has(s.text));
  const runnable = can.ok && p.canRun;
  const exit = cell.output?.attrs.exit;
  const last: { icon: CodiconName; color: string; label: string } | undefined =
    running || exit === undefined
      ? undefined
      : exit === '0' && cell.output?.attrs.check !== 'failed'
        ? { icon: 'check', color: c.ok, label: t.ranOk }
        : exit === 'skipped'
          ? undefined
          : { icon: 'error', color: c.error, label: t.ranFailed };
  const info = isCodeMeta(cell.meta) ? cell.meta.info : cell.languageId;

  const tapLine = (line: number): void => {
    if (!can.ok) return;
    const step = stepAtLine(steps, line);
    setSelected(step && sel?.start !== step.start ? step : undefined);
  };
  const act = (mode: LineMode, line: number): void => {
    setSelected(undefined);
    p.onRun(mode, line);
  };

  return (
    <Pressable testID={`cell-${index}`} style={styles.cell} onLongPress={p.onActions} delayLongPress={400} accessible={false}>
      <View style={styles.row}>
        <View style={styles.gutter}>
          {running ? (
            <>
              <Pressable
                testID={`cell-${index}-stop`}
                accessibilityRole="button"
                aria-label={t.stopCell}
                accessibilityLabel={t.stopCell}
                hitSlop={8}
                onPress={p.onStop}
                style={styles.gutterButton}
              >
                <Codicon name="debug-stop" size={18} color={c.error} />
              </Pressable>
              <ActivityIndicator size="small" color={c.muted} style={styles.spinner} />
            </>
          ) : runnable ? (
            <Pressable
              testID={`cell-${index}-run`}
              accessibilityRole="button"
              aria-label={t.runCell}
              accessibilityLabel={t.runCell}
              accessibilityState={{ disabled: p.busy }}
              disabled={p.busy}
              hitSlop={8}
              onPress={() => p.onRun()}
              style={[styles.gutterButton, p.busy && styles.disabled]}
            >
              <Codicon name="play" size={18} color={c.text} />
            </Pressable>
          ) : null}
          {last ? (
            <View testID={`cell-${index}-status`} accessibilityLabel={last.label} style={styles.lastStatus}>
              <Codicon name={last.icon} size={14} color={last.color} />
            </View>
          ) : null}
        </View>
        <View style={styles.editor}>
          {lines.map((tokens, n) => {
            const inSel = sel !== undefined && n >= sel.start && n <= sel.end;
            const paused = running?.paused?.step;
            const inRun = paused
              ? n >= paused.start && n <= paused.end
              : running?.step !== undefined && n >= running.step.start && n <= running.step.end;
            const step = stepAtLine(steps, n);
            const isChecked = step !== undefined && step.start === n && p.checked.has(step.text);
            const isBreak = step !== undefined && step.start === n && (p.breakpoints?.has(n) ?? false);
            return (
              <View key={n}>
                <Pressable
                  testID={`cell-${index}-line-${n}`}
                  onPress={() => tapLine(n)}
                  disabled={!can.ok || running !== undefined}
                  style={[styles.line, inSel && styles.lineSelected, inRun && (paused ? styles.linePaused : styles.lineRunning)]}
                >
                  <View style={styles.mark}>
                    {isBreak ? (
                      <View testID={`cell-${index}-line-${n}-dot`}>
                        <Codicon name="circle-filled" size={10} color={c.error} />
                      </View>
                    ) : isChecked ? (
                      <Codicon name="pass-filled" size={12} color={c.accent} />
                    ) : null}
                  </View>
                  <Text style={styles.source}>{tokenText(tokens, c)}</Text>
                </Pressable>
                {sel && n === sel.end && !running ? (
                  <LineActions
                    index={index}
                    step={sel}
                    steps={steps}
                    canRun={runnable && !p.busy}
                    checked={p.checked.has(sel.text)}
                    onAct={act}
                    onToggleCheck={() => p.onToggleCheck(sel)}
                    breakpoint={p.breakpoints?.has(sel.start) ?? false}
                    {...(p.onToggleBreakpoint ? { onToggleBreakpoint: () => p.onToggleBreakpoint!(sel) } : {})}
                    {...(p.onExplainLine ? { onExplain: () => p.onExplainLine!(sel) } : {})}
                    onClose={() => setSelected(undefined)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
      <View style={styles.statusLine}>
        <View style={styles.statusLeft}>
          {can.ok && runnable && !running ? (
            <View style={styles.statusButtons}>
              {steps.length > 1 ? (
                <Pressable
                  testID={`cell-${index}-step`}
                  accessibilityRole="button"
                  disabled={p.busy}
                  onPress={() => p.onRun('step', 0)}
                  style={[styles.statusButton, p.busy && styles.disabled]}
                >
                  <Codicon name="debug-step-over" size={12} color={c.link} />
                  <Text style={styles.statusLink}>{t.stepThrough}</Text>
                </Pressable>
              ) : null}
              {checkedSteps.length > 0 ? (
                <Pressable
                  testID={`cell-${index}-run-checked`}
                  accessibilityRole="button"
                  disabled={p.busy}
                  onPress={() => p.onRun('checked', 0)}
                  style={[styles.statusButton, p.busy && styles.disabled]}
                >
                  <Codicon name="play" size={12} color={c.link} />
                  <Text style={styles.statusLink}>{t.runChecked(checkedSteps.length)}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
        <Text style={styles.statusText} numberOfLines={1}>
          {info}
        </Text>
        {p.onActions ? (
          <Pressable
            testID={`cell-${index}-actions`}
            accessibilityRole="button"
            accessibilityLabel={t.cellActions}
            onPress={p.onActions}
            hitSlop={8}
          >
            <Codicon name="ellipsis" size={14} color={c.link} />
          </Pressable>
        ) : null}
      </View>
      {/* Why it doesn't run here: a line of its own (beside the options it was squeezed to a sliver). */}
      {!can.ok ? (
        <Text testID={`cell-${index}-why`} style={[styles.why, (can.why === 'proposed' || can.why === 'unverified') && styles.whyProposed]}>
          {t.notRunnable[can.why](can.detail)}
        </Text>
      ) : null}
      {running ? (
        <View testID={`cell-${index}-live`} style={styles.output}>
          {running.paused ? (
            <View testID={`cell-${index}-paused`} style={styles.stepBar}>
              <Codicon name="debug-pause" size={14} color={c.warning} />
              <Text style={styles.outputHeader}>{t.pausedBefore(lineLabel(running.paused.step))}</Text>
              <Pressable
                testID={`cell-${index}-step-next`}
                accessibilityRole="button"
                onPress={running.paused.next}
                style={styles.statusButton}
              >
                <Codicon name="debug-step-over" size={14} color={c.link} />
                <Text style={styles.statusLink}>{t.runNext}</Text>
              </Pressable>
              <Pressable
                testID={`cell-${index}-step-continue`}
                accessibilityRole="button"
                onPress={running.paused.cont}
                style={styles.statusButton}
              >
                <Codicon name="debug-continue" size={14} color={c.link} />
                <Text style={styles.statusLink}>{t.continueRun}</Text>
              </Pressable>
            </View>
          ) : (
            <Text testID={`cell-${index}-running`} style={styles.outputHeader}>
              {running.step
                ? t.runningLine(lineLabel(running.step))
                : running.attempt
                  ? running.attempt.waitMs !== undefined
                    ? t.retryWaiting(running.attempt.n, running.attempt.of, formatWait(running.attempt.waitMs))
                    : t.runningAttempt(running.attempt.n, running.attempt.of)
                  : t.running}
            </Text>
          )}
          {running.live !== '' ? <OutputText style={styles.outputText} text={running.live} /> : null}
        </View>
      ) : cell.output ? (
        <View testID={`cell-${index}-output`} style={styles.output}>
          <Text style={styles.outputHeader}>
            {t.output}
            {' · '}
            {outputSummary(cell.output.attrs)}
          </Text>
          {cell.output.text !== '' ? (
            <OutputText style={styles.outputText} text={cell.output.text} stderr={cell.output.attrs.stderr} />
          ) : null}
          {cloud ? <CloudView testID={`cell-${index}-cloud`} view={cloud} /> : null}
        </View>
      ) : null}
      {p.below}
    </Pressable>
  );
});

function LineActions(p: {
  index: number;
  step: LineStep;
  steps: readonly LineStep[];
  canRun: boolean;
  checked: boolean;
  onAct(mode: LineMode, line: number): void;
  onToggleCheck(): void;
  breakpoint: boolean;
  onToggleBreakpoint?(): void;
  onExplain?(): void;
  onClose(): void;
}) {
  const styles = useStyles();
  const c = usePalette();
  const first = p.steps[0]!;
  const last = p.steps[p.steps.length - 1]!;
  const id = `cell-${p.index}-line-${p.step.start}`;
  const action = (key: string, icon: CodiconName, label: string, onPress: () => void, enabled = p.canRun) => (
    <Pressable
      key={key}
      testID={`${id}-${key}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={[styles.action, !enabled && styles.disabled]}
    >
      <Codicon name={icon} size={14} color={c.link} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
  return (
    <View testID={`${id}-actions`} style={styles.actions}>
      {action('run', 'play', t.runLine(lineLabel(p.step)), () => p.onAct('at', p.step.start))}
      {p.step !== first && p.step.start !== first.start
        ? action('run-to', 'run-above', t.runLinesTo(lineLabel({ start: first.start, end: p.step.end })), () => p.onAct('to', p.step.start))
        : null}
      {p.step.start !== last.start
        ? action('run-from', 'run-below', t.runLinesFrom(lineLabel({ start: p.step.start, end: last.end })), () =>
            p.onAct('from', p.step.start),
          )
        : null}
      {p.step.start !== last.start ? action('step-from', 'debug-step-over', t.stepFromHere, () => p.onAct('stepFrom', p.step.start)) : null}
      {action('check', p.checked ? 'pass-filled' : 'circle-large-outline', p.checked ? t.uncheckLine : t.checkLine, p.onToggleCheck, true)}
      {p.onToggleBreakpoint
        ? action('breakpoint', 'circle-filled', p.breakpoint ? t.removeBreakpoint : t.addBreakpoint, p.onToggleBreakpoint, true)
        : null}
      {p.onExplain ? action('explain', 'sparkle', t.explainLine, p.onExplain, true) : null}
      <Pressable
        testID={`${id}-close`}
        accessibilityRole="button"
        aria-label={t.closeActions}
        accessibilityLabel={t.closeActions}
        onPress={p.onClose}
        style={styles.action}
      >
        <Codicon name="close" size={14} color={c.muted} />
      </Pressable>
    </View>
  );
}

function tokenText(tokens: readonly Token[], c: Palette) {
  // An empty line still needs its height.
  if (tokens.length === 0) return ' ';
  return tokens.map((tok, i) =>
    tok.kind === 'plain' ? (
      tok.text
    ) : (
      <Text key={i} style={{ color: c.syntax[tok.kind] }}>
        {tok.text}
      </Text>
    ),
  );
}

const useStyles = themedStyles((c) => ({
  cell: { marginVertical: 8 },
  row: { flexDirection: 'row' },
  gutter: { width: 34, alignItems: 'center', paddingTop: 6, gap: 6 },
  gutterButton: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  spinner: { transform: [{ scale: 0.8 }] },
  lastStatus: { alignItems: 'center' },
  disabled: { opacity: 0.4 },
  editor: {
    flex: 1,
    backgroundColor: c.codeBackground,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  line: { flexDirection: 'row', paddingRight: 8, minHeight: 20 },
  lineSelected: { backgroundColor: c.lineHighlight },
  lineRunning: { backgroundColor: c.dark ? '#4b4b18' : '#ffff6680' },
  linePaused: { backgroundColor: c.dark ? '#264f78' : '#cce5ff' },
  statusButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stepBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  mark: { width: 18, alignItems: 'center', justifyContent: 'center' },
  source: { flex: 1, fontFamily: mono, fontSize: 13, lineHeight: 20, color: c.syntax.operator },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 2,
    backgroundColor: c.background,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 4 },
  actionText: { fontSize: 13, color: c.link },
  statusLine: { flexDirection: 'row', alignItems: 'center', marginLeft: 34, paddingHorizontal: 4, paddingTop: 4, minHeight: 24, gap: 8 },
  statusLeft: { flex: 1 },
  statusText: { fontSize: 12, color: c.muted, flexShrink: 1 },
  why: { fontSize: 12, lineHeight: 17, color: c.muted, marginLeft: 38, paddingHorizontal: 4, paddingTop: 2 },
  whyProposed: { color: c.warning },
  statusButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusLink: { fontSize: 12, color: c.link },
  output: { marginLeft: 34, marginTop: 4, paddingHorizontal: 8, paddingVertical: 6, gap: 4 },
  outputHeader: { fontSize: 12, color: c.muted },
  outputText: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: c.text },
}));

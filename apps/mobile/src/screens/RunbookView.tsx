import { Link, Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ParsedCell, clearOutputBlocks, isCodeMeta, parse, taskItems } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { SignedStatus, signedStatus } from '@md-runbook/core/signing';
import { textProgress } from '@md-runbook/core/textProgress';
import type { Progress } from '@md-runbook/core';
import { LineStep } from '@md-runbook/core/steps';
import { hostKeyId } from '@md-runbook/ssh';
import { CodeCell } from '../cells/CodeCell';
import { SaveBar } from '../cells/SaveBar';
import { Host, getHost, pinHostKey, useHosts } from '../hosts/store';
import { t } from '../i18n';
import { MarkdownView, countTaskBoxes } from '../markdown/MarkdownView';
import { ParamSpec, checkParam, runbookParams, setParamValue, useParamValues } from '../runbooks/params';
import { canDownload } from '../runbooks/files';
import { saveRunbook } from '../runbooks/save';
import { getRunbook, updateRunbookText, useRunbooks } from '../runbooks/store';
import { fingerprint } from '../ssh/fingerprint';
import { LineMode, isStepping, planLines } from '../ssh/lineRuns';
import { runnability } from '../ssh/cells';
import { disconnect, isConnected } from '../ssh/connections';
import { NeededValue, runCell } from '../ssh/runCell';
import { storeSecret } from '../secrets/store';
import { transportReady } from '../ssh/transport';
import { mono, themedStyles, usePalette } from '../theme';
import { ActionGroup, ActionsSheet, AppAction } from '../ui/ActionsSheet';

const CHEAT_SHEET_URL = 'https://github.com/smojon/md-runbook/blob/main/docs/cheatsheet.md';

/** Output kept on screen while a cell runs; the output block written afterwards has its own limit. */
const LIVE_CHARS = 20_000;

/** What to run: the whole cell, or some of its commands (`mode` and the line it was asked on). */
interface RunRequest {
  cellIndex: number;
  mode?: LineMode;
  line?: number;
}

interface Running extends RunRequest {
  live: string;
  abort: AbortController;
  step?: { start: number; end: number };
  /** Step through: waiting before this command until Run next, Continue or Stop. */
  paused?: Paused;
}

interface Paused {
  step: { start: number; end: number };
  next(): void;
  /** Run the rest without pausing. */
  cont(): void;
  stop(): void;
}

interface Trust {
  request: RunRequest;
  /** The host that showed the key (the cell's host= one, or the selected one). */
  hostId: string;
  hostKey: string;
  fingerprint: string;
  changed: boolean;
}

/** A runbook drawn like VS Code's notebook: Markdown cells rendered, code cells that run over SSH. */
export function RunbookView({ id }: { id: string | undefined }) {
  const styles = useStyles();
  const runbook = useRunbooks().find((r) => r.id === id);
  const cells = useMemo(() => (runbook ? parse(runbook.text).cells : []), [runbook]);
  const progress = useMemo(() => (runbook ? textProgress(runbook.text) : undefined), [runbook]);
  const signed = useMemo(() => (runbook ? signedStatus(runbook.text) : undefined), [runbook]);
  const params = useMemo(() => (runbook ? runbookParams(runbook.text) : []), [runbook]);
  const paramValues = useParamValues(runbook?.id ?? '');
  const hosts = useHosts();
  const [hostId, setHostId] = useState<string | undefined>();
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];
  const [running, setRunning] = useState<Running | undefined>();
  const [trust, setTrust] = useState<Trust | undefined>();
  /** Secrets to store and inputs to type before a cell can run. */
  const [asking, setAsking] = useState<{ request: RunRequest; hostId: string; needs: NeededValue[] } | undefined>();
  /** ${input:NAME} values for as long as this runbook is open (as in the extension's session). */
  const [typedInputs, setTypedInputs] = useState<Readonly<Record<string, TypedInput>>>({});
  // The runs read the latest values (a run started right after typing them sees them).
  const inputs = useRef(typedInputs);
  const updateInputs = (next: Readonly<Record<string, TypedInput>>): void => {
    inputs.current = next;
    setTypedInputs(next);
  };
  /** A cell is running (a ref: Run all starts the next one before React re-renders). */
  const busy = useRef(false);
  /** Run all / Continue: the cells still to run, the host, and the proposals left out. */
  const queue = useRef<{ cells: number[]; on: Host | undefined; proposed: number } | undefined>(undefined);
  const [queued, setQueued] = useState(false);
  const clearQueue = (): void => {
    queue.current = undefined;
    setQueued(false);
  };
  const [notice, setNotice] = useState<string | undefined>();
  const [transportIssue, setTransportIssue] = useState<string | undefined>();
  /** Checked commands per cell index (their texts), for this screen's life, as in the extension's session. */
  const [checks, setChecks] = useState<ReadonlyMap<number, ReadonlySet<string>>>(new Map());
  useEffect(() => {
    let live = true;
    void transportReady().then((why) => live && setTransportIssue(why));
    return () => {
      live = false;
    };
  }, []);

  // Task boxes: box k on screen is the k-th task item of the file. If the renderer and the file
  // scan ever disagree on the count, the boxes stay read-only rather than tick the wrong line.
  const tasks = useMemo(() => {
    const first: number[] = [];
    let n = 0;
    for (const c of cells) {
      first.push(n);
      if (c.kind === 'markup') n += countTaskBoxes(c.value);
    }
    return { first, aligned: runbook !== undefined && n === taskItems(runbook.text).length };
  }, [cells, runbook]);
  const toggleTask = useCallback(
    (k: number): void => {
      const current = getRunbook(id);
      if (!current) return;
      const item = taskItems(current.text)[k];
      if (!item) return;
      updateRunbookText(current.id, current.text.slice(0, item.offset) + (item.checked ? ' ' : 'x') + current.text.slice(item.offset + 1));
    },
    [id],
  );

  const run = async (request: RunRequest, on: Host | undefined): Promise<void> => {
    if (!runbook || busy.current) return;
    busy.current = true;
    try {
      await runOne(request, on);
    } finally {
      busy.current = false;
    }
    // Run all / Continue: on to the next cell, after this render has caught up.
    if (queue.current) setTimeout(() => runNext(), 0);
  };
  const runOne = async (request: RunRequest, on: Host | undefined): Promise<void> => {
    if (!runbook) return;
    const { cellIndex, mode, line } = request;
    const cell = cells[cellIndex];
    // host=NAME: that host, whichever is selected (as the store has it now: a key may just have been pinned).
    const named = cell && isCodeMeta(cell.meta) ? parseCellOptions(cell.meta.info).host : undefined;
    const match = named === undefined ? on : hosts.find((h) => h.name.toLowerCase() === named.toLowerCase());
    const target = match && (getHost(match.id) ?? match);
    if (named !== undefined && !target) {
      clearQueue();
      setNotice(t.noHostNamed(named));
      return;
    }
    if (!target) return clearQueue();
    const lines = mode && cell ? planLines(cell.value, mode, line ?? 0, checks.get(cellIndex)) : undefined;
    if (mode && !lines) return;
    const abort = new AbortController();
    setNotice(undefined);
    setTrust(undefined);
    setRunning({ ...request, live: '', abort });
    const update = (f: (r: Running) => Running): void => setRunning((r) => (r && r.cellIndex === cellIndex ? f(r) : r));
    // Step through: the first command runs at once, then the run waits before each of the others.
    let auto = false;
    const beforeStep =
      isStepping(mode) && lines
        ? (i: number): Promise<boolean> =>
            i === 0 || auto
              ? Promise.resolve(true)
              : new Promise<boolean>((resolve) => {
                  const go = (yes: boolean): void => {
                    update((r) => ({ ...r, paused: undefined }));
                    resolve(yes);
                  };
                  abort.signal.addEventListener('abort', () => go(false), { once: true });
                  update((r) => ({
                    ...r,
                    paused: {
                      step: lines.steps[i]!,
                      next: () => go(true),
                      cont: () => {
                        auto = true;
                        go(true);
                      },
                      stop: () => go(false),
                    },
                  }));
                })
        : undefined;
    const outcome = await runCell({
      host: target,
      text: runbook.text,
      cellIndex,
      signal: abort.signal,
      lines,
      beforeStep,
      params: paramValues,
      inputs: Object.fromEntries(Object.entries(inputs.current).map(([k, v]) => [k, v.value])),
      latestText: () => getRunbook(runbook.id)?.text ?? runbook.text,
      onStep: (i) => update((r) => ({ ...r, step: i === undefined || !lines ? undefined : lines.steps[i] })),
      onOutput: (text) => update((r) => ({ ...r, live: (r.live + text).slice(-LIVE_CHARS) })),
    });
    setRunning(undefined);
    if (outcome.kind === 'done') {
      updateRunbookText(runbook.id, outcome.text);
      if (outcome.result.newShell) setNotice(t.newShell);
      // Run all stops at the first failure, unless the cell says continue-on-error.
      const passed = outcome.attrs.exit === '0' && outcome.attrs.check !== 'failed';
      const goOn = cell && isCodeMeta(cell.meta) && parseCellOptions(cell.meta.info).continueOnError;
      if (queue.current && (outcome.result.cancelled || (!passed && !goOn))) {
        clearQueue();
        if (!outcome.result.cancelled) setNotice(t.runStopped);
      }
    } else if (outcome.kind === 'trust') {
      setTrust({
        request,
        hostId: target.id,
        hostKey: outcome.hostKey,
        fingerprint: await fingerprint(outcome.hostKey),
        changed: outcome.changed,
      });
    } else if (outcome.kind === 'needs') setAsking({ request, hostId: target.id, needs: outcome.needs });
    else {
      clearQueue();
      setNotice(outcome.message);
    }
  };
  /** Start the next cell of Run all / Continue (with the newest render's state). */
  const runNext = (): void => {
    const q = queue.current;
    if (!q) return;
    const next = q.cells.shift();
    if (next === undefined) {
      clearQueue();
      if (q.proposed > 0) setNotice(t.proposedNotRun(q.proposed));
      return;
    }
    void runRef.current({ cellIndex: next }, q.on);
  };
  /** Run all (from the top) or Continue (the failed or pending cells from the first such one on). */
  const runSequence = (from: 'start' | 'resume'): void => {
    if (!runbook || busy.current || !host) return;
    const parsed = parse(runbook.text).cells;
    const candidates =
      from === 'start' ? parsed.map((c, i) => (c.kind === 'code' ? i : -1)).filter((i) => i >= 0) : textProgress(runbook.text).resume;
    const verdicts = candidates.map((i) => ({ i, can: runnability(parsed[i]!) }));
    queue.current = {
      cells: verdicts.filter((v) => v.can.ok).map((v) => v.i),
      on: host,
      proposed: verdicts.filter((v) => !v.can.ok && v.can.why === 'proposed').length,
    };
    setQueued(true);
    setNotice(undefined);
    runNext();
  };
  const [showActions, setShowActions] = useState(false);
  const list = useRef<FlatList<ParsedCell>>(null);
  // Ctrl/⌘+K opens the actions with a keyboard (the browser, an iPad with a keyboard).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowActions(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const action = (id: keyof typeof t.actions, group: ActionGroup, run: () => void, disabled?: string): AppAction => ({
    id,
    title: t.actions[id][0],
    hint: t.actions[id][1],
    group,
    run,
    ...(disabled ? { disabled } : {}),
  });
  const actions: AppAction[] = runbook
    ? [
        queued || running
          ? action('stop', 'run', () => stopSequence())
          : action('runAll', 'run', () => runSequence('start'), host ? undefined : t.noRunNow),
        action(
          'resumeRun',
          'run',
          () => runSequence('resume'),
          !host ? t.noRunNow : progress?.resume.length ? undefined : t.nothingToResume,
        ),
        action('nextStep', 'run', () => {
          const at = progress?.firstFailed?.cell ?? progress?.firstPending?.cell;
          if (at !== undefined) list.current?.scrollToIndex({ index: at, viewPosition: 0.2 });
        }),
        action(
          'restartSession',
          'run',
          () => {
            for (const h of hosts) if (isConnected(h.id)) void disconnect(h.id);
          },
          hosts.some((h) => isConnected(h.id)) ? undefined : t.noSessionOpen,
        ),
        action('clearAllOutputs', 'run', () => updateRunbookText(runbook.id, clearOutputBlocks(runbook.text))),
        action('hosts', 'run', () => router.push('/hosts')),
        ...(params.length > 0 ? [action('setParameters', 'values', () => list.current?.scrollToOffset({ offset: 0 }))] : []),
        action('resetInputs', 'values', () => updateInputs({}), Object.keys(typedInputs).length > 0 ? undefined : t.noInputsYet),
        action('secrets', 'values', () => router.push('/hosts')),
        runbook.origin
          ? action('save', 'share', () => void saveFromMenu())
          : action('download', 'share', () => void saveFromMenu(), canDownload ? undefined : t.saveUnavailable),
        action('cheatSheet', 'help', () => void Linking.openURL(CHEAT_SHEET_URL)),
        action('sample', 'help', () => router.push({ pathname: '/runbook/[id]', params: { id: 'sample' } })),
      ]
    : [];
  const saveFromMenu = async (): Promise<void> => {
    if (!runbook) return;
    const r = await saveRunbook(runbook.id);
    setNotice(r.kind === 'conflict' ? t.conflictTitle : r.kind === 'error' ? r.message : r.kind === 'downloaded' ? undefined : t.saved);
  };
  const stopSequence = (): void => {
    clearQueue();
    if (running?.paused) running.paused.stop();
    else running?.abort.abort();
  };
  const runRef = useRef(run);
  // Run all calls the newest render's run (its runbook text and values), not the first one's.
  useEffect(() => {
    runRef.current = run;
  });
  const provide = async (values: Record<string, string>): Promise<void> => {
    if (!asking) return;
    const { request, hostId, needs } = asking;
    let next = inputs.current;
    for (const n of needs) {
      const v = values[n.name] ?? '';
      if (n.kind === 'secret') await storeSecret(n.name, v);
      else next = { ...next, [n.name]: { value: v, masked: n.masked } };
    }
    updateInputs(next);
    setAsking(undefined);
    void run(request, getHost(hostId));
  };
  const acceptTrust = (): void => {
    if (!trust) return;
    pinHostKey(trust.hostId, hostKeyId(trust.hostKey));
    const { request, hostId } = trust;
    setTrust(undefined);
    // The pinned key is on the host as the store has it now, not on the hosts of this render.
    void run(request, getHost(hostId));
  };
  const trustHost = trust ? hosts.find((h) => h.id === trust.hostId) : undefined;
  const toggleCheck = (cellIndex: number, step: LineStep): void =>
    setChecks((m) => {
      const next = new Set(m.get(cellIndex));
      if (next.has(step.text)) next.delete(step.text);
      else next.add(step.text);
      return new Map(m).set(cellIndex, next);
    });

  // Scroll views as the screen's root with automatic insets (see RunbookList).
  if (!runbook) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <Text testID="runbook-not-found" style={styles.text}>
          {t.notFound}
        </Text>
      </ScrollView>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: runbook.title }} />
      <FlatList
        ref={list}
        onScrollToIndexFailed={(info) => list.current?.scrollToOffset({ offset: info.averageItemLength * info.index })}
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={cells}
        keyExtractor={(_, i) => String(i)}
        ListHeaderComponent={
          <View>
            <RunBar
              progress={progress}
              canRun={host !== undefined}
              running={queued}
              onRun={runSequence}
              onStop={stopSequence}
              onMore={() => setShowActions(true)}
            />
            <ActionsSheet actions={actions} visible={showActions} onClose={() => setShowActions(false)} />
            <SaveBar runbook={runbook} />
            {signed ? <SignedBanner status={signed} /> : null}
            {params.length > 0 ? (
              <ParamsCard specs={params} values={paramValues} onChange={(name, value) => setParamValue(runbook.id, name, value)} />
            ) : null}
            <HostPicker hosts={hosts} selected={host} onSelect={setHostId} />
            {transportIssue ? (
              <Text testID="transport-issue" style={styles.warning}>
                {transportIssue}
              </Text>
            ) : null}
            {notice ? (
              <Text testID="run-notice" role="alert" style={styles.warning}>
                {notice}
              </Text>
            ) : null}
            {Object.keys(typedInputs).length > 0 ? (
              <InputsCard
                inputs={typedInputs}
                onChange={(name, value) => updateInputs({ ...inputs.current, [name]: { ...inputs.current[name]!, value } })}
                onClear={(name) => updateInputs(Object.fromEntries(Object.entries(inputs.current).filter(([k]) => k !== name)))}
                onClearAll={() => updateInputs({})}
              />
            ) : null}
            {asking ? (
              <NeedsCard
                needs={asking.needs}
                onRun={(v) => void provide(v)}
                onCancel={() => {
                  clearQueue();
                  setNotice(t.needsCancelled(asking.needs.map((n) => n.name).join(', ')));
                  setAsking(undefined);
                }}
              />
            ) : null}
            {trust && trustHost ? (
              <TrustCard
                host={trustHost}
                trust={trust}
                onAccept={acceptTrust}
                onDecline={() => {
                  clearQueue();
                  setTrust(undefined);
                }}
              />
            ) : null}
          </View>
        }
        renderItem={({ item, index }) =>
          item.kind === 'markup' ? (
            <View style={styles.markup}>
              <MarkdownView
                testID={`cell-${index}`}
                markdown={item.value}
                firstTask={tasks.first[index]}
                onToggleTask={tasks.aligned ? toggleTask : undefined}
              />
            </View>
          ) : (
            <CodeCell
              cell={item}
              index={index}
              canRun={host !== undefined}
              running={running?.cellIndex === index ? running : undefined}
              busy={running !== undefined && running.cellIndex !== index}
              checked={checks.get(index) ?? EMPTY}
              onRun={(mode, line) => void run({ cellIndex: index, mode, line }, host)}
              onStop={stopSequence}
              onToggleCheck={(step) => toggleCheck(index, step)}
            />
          )
        }
      />
    </>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The one obvious action, for anyone opening the runbook: Run all, then Continue after a stop,
 * Run again when everything is done; with how far the runbook is. Everything else stays one tap
 * away (cells, lines, the menu).
 */
function RunBar({
  progress,
  canRun,
  running,
  onRun,
  onStop,
  onMore,
}: {
  progress: Progress | undefined;
  canRun: boolean;
  running: boolean;
  onRun(from: 'start' | 'resume'): void;
  onStop(): void;
  onMore(): void;
}) {
  const styles = useStyles();
  const more = (
    <Pressable testID="more-actions" accessibilityRole="button" onPress={onMore} style={styles.more}>
      <Text style={styles.secondaryText}>{t.moreActions}</Text>
    </Pressable>
  );
  if (!progress || progress.total === 0) return <View style={styles.runBar}>{more}</View>;
  const complete = progress.done + progress.skipped;
  const fresh = complete === 0 && progress.failed === 0;
  const finished = progress.pending === 0 && progress.failed === 0;
  const resume = !fresh && !finished && progress.resume.length > 0;
  const label = running ? t.stopRun : fresh || finished || !resume ? (finished ? t.runAgain : t.runAll) : t.continueRunbook;
  return (
    <View testID="run-bar" style={styles.runBar}>
      <Pressable
        testID="run-primary"
        accessibilityRole="button"
        disabled={!canRun && !running}
        onPress={() => (running ? onStop() : onRun(resume ? 'resume' : 'start'))}
        style={[styles.runPrimary, running && styles.runStop, !canRun && !running && styles.disabled]}
      >
        <Text style={styles.runPrimaryText}>{label}</Text>
      </Pressable>
      <View style={styles.grow}>
        <Text testID="run-progress" style={styles.runProgress}>
          {t.progressDone(complete, progress.total)}
          {progress.firstFailed ? t.progressFailed(progress.firstFailed.step) : ''}
        </Text>
        {resume && !running ? (
          <Pressable testID="run-from-start" accessibilityRole="button" onPress={() => onRun('start')}>
            <Text style={styles.secondaryText}>{t.runFromStart}</Text>
          </Pressable>
        ) : null}
      </View>
      {more}
    </View>
  );
}

/** An `${input:NAME}` value typed while this runbook is open. */
interface TypedInput {
  value: string;
  masked: boolean;
}

/** The inputs typed so far: seen (masked ones as dots), changed, cleared (then asked again). */
function InputsCard({
  inputs,
  onChange,
  onClear,
  onClearAll,
}: {
  inputs: Readonly<Record<string, TypedInput>>;
  onChange(name: string, value: string): void;
  onClear(name: string): void;
  onClearAll(): void;
}) {
  const styles = useStyles();
  const [editing, setEditing] = useState<{ name: string; value: string } | undefined>();
  return (
    <View testID="inputs" style={styles.params}>
      <Text style={styles.paramsTitle}>{t.inputsTitle}</Text>
      {Object.entries(inputs).map(([name, input]) => (
        <View key={name} style={styles.param}>
          <View style={styles.inputRow}>
            <Text style={styles.paramName}>{`${name} = ${input.masked ? '••••••' : input.value}`}</Text>
            <View style={styles.actions}>
              <Pressable
                testID={`input-change-${name}`}
                accessibilityRole="button"
                onPress={() => setEditing({ name, value: input.masked ? '' : input.value })}
              >
                <Text style={styles.secondaryText}>{t.changeSecret}</Text>
              </Pressable>
              <Pressable testID={`input-clear-${name}`} accessibilityRole="button" onPress={() => onClear(name)}>
                <Text style={styles.secondaryText}>{t.clearInput}</Text>
              </Pressable>
            </View>
          </View>
          {editing?.name === name ? (
            <View style={styles.inputRow}>
              <TextInput
                testID={`input-value-${name}`}
                accessibilityLabel={name}
                style={[styles.paramInput, styles.grow]}
                value={editing.value}
                onChangeText={(value) => setEditing({ name, value })}
                secureTextEntry={input.masked}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                testID={`input-save-${name}`}
                accessibilityRole="button"
                onPress={() => {
                  onChange(name, editing.value);
                  setEditing(undefined);
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>{t.save}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
      <Pressable testID="inputs-clear-all" accessibilityRole="button" onPress={onClearAll}>
        <Text style={styles.secondaryText}>{t.clearInputs}</Text>
      </Pressable>
    </View>
  );
}

/** Ask for the secrets and inputs a cell needs: secrets are stored for every runbook, inputs kept while this one is open. */
function NeedsCard({
  needs,
  onRun,
  onCancel,
}: {
  needs: readonly NeededValue[];
  onRun(values: Record<string, string>): void;
  onCancel(): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = needs.every((n) => (values[n.name] ?? '') !== '');
  return (
    <View testID="needs" style={styles.trust}>
      <Text style={styles.trustTitle}>{t.needsTitle}</Text>
      {needs.map((n) => (
        <View key={n.name} style={styles.param}>
          <Text style={styles.paramName}>{n.kind === 'secret' ? t.needSecret(n.name) : n.name}</Text>
          <TextInput
            testID={`need-${n.name}`}
            accessibilityLabel={n.name}
            style={styles.paramInput}
            value={values[n.name] ?? ''}
            onChangeText={(v) => setValues((m) => ({ ...m, [n.name]: v }))}
            secureTextEntry={n.masked}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.paramHint}>{n.kind === 'secret' ? t.needSecretHint : t.needInputHint}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable
          testID="needs-run"
          accessibilityRole="button"
          disabled={!complete}
          onPress={() => onRun(values)}
          style={[styles.button, !complete && styles.disabled]}
        >
          <Text style={styles.buttonText}>{t.needsRun}</Text>
        </Pressable>
        <Pressable testID="needs-cancel" accessibilityRole="button" onPress={onCancel} style={styles.secondary}>
          <Text style={styles.secondaryText}>{t.trustDecline}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The runbook's `${param:NAME}` values: typed here, the default as placeholder, checked against a signed pattern. */
function ParamsCard({
  specs,
  values,
  onChange,
}: {
  specs: readonly ParamSpec[];
  values: Record<string, string>;
  onChange(name: string, value: string): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  return (
    <View testID="params" style={styles.params}>
      <Text style={styles.paramsTitle}>{t.paramsTitle}</Text>
      {specs.map((s) => {
        const value = values[s.name] ?? '';
        const bad = value === '' ? undefined : checkParam(s, value);
        return (
          <View key={s.name} style={styles.param}>
            <Text style={styles.paramName}>{s.name}</Text>
            <TextInput
              testID={`param-${s.name}`}
              accessibilityLabel={s.name}
              style={styles.paramInput}
              value={value}
              onChangeText={(v) => onChange(s.name, v)}
              placeholder={s.default}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {s.pattern !== undefined ? (
              <Text testID={`param-${s.name}-hint`} style={bad ? styles.warning : styles.paramHint}>
                {bad === 'newline' ? t.paramNewline(s.name) : t.paramPattern(s.pattern)}
              </Text>
            ) : bad === 'newline' ? (
              <Text style={styles.warning}>{t.paramNewline(s.name)}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** A signed runbook: who signed which version, and the blocks changed since (a gate refuses those). */
function SignedBanner({ status }: { status: SignedStatus }) {
  const styles = useStyles();
  const m = status.manifest;
  return (
    <View testID="signed-banner" style={styles.signed}>
      <Text style={styles.signedTitle}>{t.signedTitle(m.name, m.version, status.block.signer)}</Text>
      <Text style={styles.signedBody}>{m.expires ? t.signedUntil(m.expires) + ' ' + t.signedBody : t.signedBody}</Text>
      {status.changed.length > 0 ? (
        <Text testID="signed-changed" style={styles.warning}>
          {t.signedChanged(status.changed.length)}
        </Text>
      ) : null}
    </View>
  );
}

function HostPicker({ hosts, selected, onSelect }: { hosts: readonly Host[]; selected: Host | undefined; onSelect(id: string): void }) {
  const styles = useStyles();
  if (hosts.length === 0) {
    return (
      <Link href={{ pathname: '/hosts', params: {} }} asChild>
        <Pressable testID="add-host-link" accessibilityRole="link" style={styles.picker}>
          <Text style={styles.link}>{t.addHostToRun}</Text>
        </Pressable>
      </Link>
    );
  }
  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{t.runOn}</Text>
      {hosts.map((h) => {
        const on = h.id === selected?.id;
        return (
          <Pressable
            key={h.id}
            testID={`host-chip-${h.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            aria-selected={on}
            onPress={() => onSelect(h.id)}
            style={[styles.chip, on && styles.chipOn]}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{h.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TrustCard({ host, trust, onAccept, onDecline }: { host: Host; trust: Trust; onAccept(): void; onDecline(): void }) {
  const styles = useStyles();
  return (
    <View testID="trust-host" style={styles.trust}>
      <Text style={styles.trustTitle}>{trust.changed ? t.trustChangedTitle(host.name) : t.trustTitle(host.name)}</Text>
      <Text style={styles.trustBody}>{trust.changed ? t.trustChangedBody : t.trustBody}</Text>
      <Text testID="trust-fingerprint" style={styles.fingerprint} selectable>
        {trust.fingerprint}
      </Text>
      <View style={styles.actions}>
        <Pressable testID="trust-accept" accessibilityRole="button" onPress={onAccept} style={styles.button}>
          <Text style={styles.buttonText}>{t.trustAccept}</Text>
        </Pressable>
        <Pressable testID="trust-decline" accessibilityRole="button" onPress={onDecline} style={styles.secondary}>
          <Text style={styles.secondaryText}>{t.trustDecline}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { padding: 12, paddingBottom: 48 },
  text: { color: c.text },
  picker: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingVertical: 8 },
  pickerLabel: { fontSize: 13, color: c.muted },
  chip: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { fontSize: 14, color: c.text },
  chipTextOn: { color: c.onAccent },
  link: { fontSize: 15, color: c.link },
  warning: { fontSize: 13, color: c.error, marginVertical: 6 },
  disabled: { opacity: 0.5 },
  runBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  runPrimary: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 24,
    backgroundColor: c.accent,
    minWidth: 130,
    alignItems: 'center',
  },
  runStop: { backgroundColor: c.error },
  more: { paddingVertical: 8, paddingHorizontal: 6 },
  runPrimaryText: { fontSize: 17, fontWeight: '600', color: c.onAccent },
  runProgress: { fontSize: 14, color: c.text },
  inputRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  grow: { flex: 1 },
  params: { marginVertical: 6 },
  paramsTitle: { fontSize: 13, color: c.muted, marginBottom: 4 },
  param: { marginBottom: 8 },
  paramName: { fontFamily: mono, fontSize: 13, color: c.text, marginBottom: 2 },
  paramInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 15,
    color: c.text,
  },
  paramHint: { fontSize: 12, color: c.muted, marginTop: 2 },
  signed: { borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 10, paddingVertical: 4, marginVertical: 6 },
  signedTitle: { fontSize: 14, color: c.text },
  signedBody: { fontSize: 12, color: c.muted, lineHeight: 17, marginTop: 2 },
  trust: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, marginVertical: 8 },
  trustTitle: { fontSize: 16, color: c.text, marginBottom: 6 },
  trustBody: { fontSize: 13, color: c.muted, lineHeight: 18 },
  fingerprint: { fontFamily: mono, fontSize: 13, color: c.text, marginVertical: 10 },
  actions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: c.link },
  // Markdown cells line up with the code of code cells (past the run gutter).
  markup: { marginVertical: 6, paddingLeft: 34 + 8 },
}));

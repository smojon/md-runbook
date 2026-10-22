import { Link, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { isCodeMeta, parse, taskItems } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { SignedStatus, signedStatus } from '@md-runbook/core/signing';
import { LineStep } from '@md-runbook/core/steps';
import { hostKeyId } from '@md-runbook/ssh';
import { CodeCell } from '../cells/CodeCell';
import { SaveBar } from '../cells/SaveBar';
import { Host, getHost, pinHostKey, useHosts } from '../hosts/store';
import { t } from '../i18n';
import { MarkdownView, countTaskBoxes } from '../markdown/MarkdownView';
import { getRunbook, updateRunbookText, useRunbooks } from '../runbooks/store';
import { fingerprint } from '../ssh/fingerprint';
import { LineMode, isStepping, planLines } from '../ssh/lineRuns';
import { runCell } from '../ssh/runCell';
import { transportReady } from '../ssh/transport';
import { mono, themedStyles } from '../theme';

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
  const signed = useMemo(() => (runbook ? signedStatus(runbook.text) : undefined), [runbook]);
  const hosts = useHosts();
  const [hostId, setHostId] = useState<string | undefined>();
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];
  const [running, setRunning] = useState<Running | undefined>();
  const [trust, setTrust] = useState<Trust | undefined>();
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
    if (!runbook || running) return;
    const { cellIndex, mode, line } = request;
    const cell = cells[cellIndex];
    // host=NAME: that host, whichever is selected (as the store has it now: a key may just have been pinned).
    const named = cell && isCodeMeta(cell.meta) ? parseCellOptions(cell.meta.info).host : undefined;
    const match = named === undefined ? on : hosts.find((h) => h.name.toLowerCase() === named.toLowerCase());
    const target = match && (getHost(match.id) ?? match);
    if (named !== undefined && !target) {
      setNotice(t.noHostNamed(named));
      return;
    }
    if (!target) return;
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
      latestText: () => getRunbook(runbook.id)?.text ?? runbook.text,
      onStep: (i) => update((r) => ({ ...r, step: i === undefined || !lines ? undefined : lines.steps[i] })),
      onOutput: (text) => update((r) => ({ ...r, live: (r.live + text).slice(-LIVE_CHARS) })),
    });
    setRunning(undefined);
    if (outcome.kind === 'done') {
      updateRunbookText(runbook.id, outcome.text);
      if (outcome.result.newShell) setNotice(t.newShell);
    } else if (outcome.kind === 'trust') {
      setTrust({
        request,
        hostId: target.id,
        hostKey: outcome.hostKey,
        fingerprint: await fingerprint(outcome.hostKey),
        changed: outcome.changed,
      });
    } else setNotice(outcome.message);
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
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={cells}
        keyExtractor={(_, i) => String(i)}
        ListHeaderComponent={
          <View>
            <SaveBar runbook={runbook} />
            {signed ? <SignedBanner status={signed} /> : null}
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
            {trust && trustHost ? (
              <TrustCard host={trustHost} trust={trust} onAccept={acceptTrust} onDecline={() => setTrust(undefined)} />
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
              onStop={() => (running?.paused ? running.paused.stop() : running?.abort.abort())}
              onToggleCheck={(step) => toggleCheck(index, step)}
            />
          )
        }
      />
    </>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

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

import { Link, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ParsedCell, isCodeMeta, outputSummary, parse } from '@md-runbook/core';
import { hostKeyId } from '@md-runbook/ssh';
import { Host, getHost, pinHostKey, useHosts } from '../hosts/store';
import { t } from '../i18n';
import { updateRunbookText, useRunbooks } from '../runbooks/store';
import { runnability } from '../ssh/cells';
import { fingerprint } from '../ssh/fingerprint';
import { runCell } from '../ssh/runCell';
import { transportReady } from '../ssh/transport';
import { colors, mono } from '../theme';

/** Output kept on screen while a cell runs; the output block written afterwards has its own limit. */
const LIVE_CHARS = 20_000;

interface Running {
  cellIndex: number;
  live: string;
  abort: AbortController;
}

interface Trust {
  cellIndex: number;
  hostKey: string;
  fingerprint: string;
  changed: boolean;
}

/** A runbook's cells; bash cells run on the chosen host over SSH and get their output block. */
export function RunbookView({ id }: { id: string | undefined }) {
  const runbook = useRunbooks().find((r) => r.id === id);
  const cells = useMemo(() => (runbook ? parse(runbook.text).cells : []), [runbook]);
  const hosts = useHosts();
  const [hostId, setHostId] = useState<string | undefined>();
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];
  const [running, setRunning] = useState<Running | undefined>();
  const [trust, setTrust] = useState<Trust | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [transportIssue, setTransportIssue] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void transportReady().then((why) => live && setTransportIssue(why));
    return () => {
      live = false;
    };
  }, []);

  const run = async (cellIndex: number, on: Host | undefined): Promise<void> => {
    if (!runbook || !on || running) return;
    const abort = new AbortController();
    setNotice(undefined);
    setTrust(undefined);
    setRunning({ cellIndex, live: '', abort });
    const outcome = await runCell({
      host: on,
      text: runbook.text,
      cellIndex,
      signal: abort.signal,
      onOutput: (text) => setRunning((r) => (r && r.cellIndex === cellIndex ? { ...r, live: (r.live + text).slice(-LIVE_CHARS) } : r)),
    });
    setRunning(undefined);
    if (outcome.kind === 'done') {
      updateRunbookText(runbook.id, outcome.text);
      if (outcome.result.newShell) setNotice(t.newShell);
    } else if (outcome.kind === 'trust') {
      setTrust({ cellIndex, hostKey: outcome.hostKey, fingerprint: await fingerprint(outcome.hostKey), changed: outcome.changed });
    } else setNotice(outcome.message);
  };
  const acceptTrust = (): void => {
    if (!trust || !host) return;
    pinHostKey(host.id, hostKeyId(trust.hostKey));
    const { cellIndex } = trust;
    setTrust(undefined);
    // The pinned key is on the host as the store has it now, not on the `host` of this render.
    void run(cellIndex, getHost(host.id));
  };

  // Scroll views as the screen's root with automatic insets (see RunbookList).
  if (!runbook) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <Text testID="runbook-not-found">{t.notFound}</Text>
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
            {trust && host ? <TrustCard host={host} trust={trust} onAccept={acceptTrust} onDecline={() => setTrust(undefined)} /> : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <Cell
            cell={item}
            index={index}
            canRun={host !== undefined}
            running={running?.cellIndex === index ? running : undefined}
            busy={running !== undefined && running.cellIndex !== index}
            onRun={() => void run(index, host)}
            onStop={() => running?.abort.abort()}
          />
        )}
      />
    </>
  );
}

function HostPicker({ hosts, selected, onSelect }: { hosts: readonly Host[]; selected: Host | undefined; onSelect(id: string): void }) {
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

interface CellProps {
  cell: ParsedCell;
  index: number;
  canRun: boolean;
  running: Running | undefined;
  busy: boolean;
  onRun(): void;
  onStop(): void;
}

function Cell({ cell, index, canRun, running, busy, onRun, onStop }: CellProps) {
  if (cell.kind === 'markup') {
    return (
      <Text testID={`cell-${index}`} style={styles.markup}>
        {cell.value}
      </Text>
    );
  }
  const can = runnability(cell);
  return (
    <View testID={`cell-${index}`} style={styles.code}>
      <View style={styles.cellHeader}>
        <Text style={styles.lang}>{isCodeMeta(cell.meta) ? cell.meta.lang : cell.languageId}</Text>
        {!can.ok ? (
          <Text testID={`cell-${index}-why`} style={styles.lang}>
            {t.notRunnable[can.why](can.detail)}
          </Text>
        ) : running ? (
          <Pressable testID={`cell-${index}-stop`} accessibilityRole="button" onPress={onStop} style={styles.stop}>
            <Text style={styles.buttonText}>{t.stop}</Text>
          </Pressable>
        ) : canRun ? (
          <Pressable
            testID={`cell-${index}-run`}
            accessibilityRole="button"
            disabled={busy}
            onPress={onRun}
            style={[styles.run, busy && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.run}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.source} selectable>
        {cell.value}
      </Text>
      {running ? (
        <View testID={`cell-${index}-live`} style={styles.output}>
          <Text style={styles.lang}>{t.running}</Text>
          {running.live !== '' ? (
            <Text style={styles.source} selectable>
              {running.live}
            </Text>
          ) : null}
        </View>
      ) : cell.output ? (
        <View testID={`cell-${index}-output`} style={styles.output}>
          <Text style={styles.lang}>
            {t.output}
            {' · '}
            {outputSummary(cell.output.attrs)}
          </Text>
          <Text style={styles.source} selectable>
            {cell.output.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 12 },
  picker: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingVertical: 8 },
  pickerLabel: { fontSize: 13, color: colors.muted },
  chip: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: colors.onAccent },
  link: { fontSize: 15, color: colors.accent },
  warning: { fontSize: 13, color: colors.error, marginVertical: 6 },
  trust: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, marginVertical: 8 },
  trustTitle: { fontSize: 16, color: colors.text, marginBottom: 6 },
  trustBody: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  fingerprint: { fontFamily: mono, fontSize: 13, color: colors.text, marginVertical: 10 },
  actions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: colors.accent },
  buttonText: { fontSize: 15, color: colors.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: colors.accent },
  markup: { fontSize: 15, lineHeight: 21, color: colors.text, marginVertical: 6 },
  code: { backgroundColor: colors.codeBackground, borderRadius: 6, padding: 10, marginVertical: 6 },
  cellHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, minHeight: 28 },
  lang: { fontSize: 11, color: colors.muted, flexShrink: 1 },
  run: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.accent },
  stop: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.error },
  disabled: { opacity: 0.4 },
  source: { fontFamily: mono, fontSize: 13, color: colors.text },
  output: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: 8, paddingTop: 6 },
});

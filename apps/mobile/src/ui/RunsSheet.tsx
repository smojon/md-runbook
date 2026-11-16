/**
 * Show Runs…, as in VS Code: this runbook's recorded runs, newest first. Each says how it ended
 * (done, failed at a step, how far), when, how long, who ran it and its counts; a tap shows the
 * steps it ran with their state and time. When it last ran green is at the top.
 */
import { formatEstimate } from '@md-runbook/core/estimate';
import type { RunStepState } from '@md-runbook/core/runReport';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { t } from '../i18n';
import { ago } from '../runbooks/params';
import { RunLogEntry, lastGreen, useRunLog } from '../runbooks/runLog';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from './Codicon';
import { Grabber } from './Grabber';
import { Points } from './Points';
import { useNow } from './TimeBar';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `16 Nov 14:32` in local time, with the year when it is not this year's. */
export function formatWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How a run ended, in a few words: done, failed at a step, or how far it got. */
export function runHeadline(r: RunLogEntry): string {
  const failed = r.steps.find((s) => s.state === 'failed');
  if (failed) return t.runFailedAt(failed.label);
  if (r.green) return t.runDone(r.complete, r.total);
  return t.runPartly(r.complete, r.total);
}

/** Who, the counts and the copy it ran in: `by ana · 3 passed, 1 failed`. */
export function runDetail(r: RunLogEntry): string {
  const n = (state: RunStepState): number => r.steps.filter((s) => s.state === state).length;
  const counts = [
    t.runPassed(n('passed')),
    ...(n('failed') ? [t.runFailedCount(n('failed'))] : []),
    ...(n('skipped') ? [t.runSkipped(n('skipped'))] : []),
  ].join(', ');
  return [...(r.by ? [t.runBy(r.by)] : []), counts, ...(r.copy ? [t.runIn(r.copy)] : [])].join(' · ');
}

const ICON: Record<RunStepState, 'pass' | 'error' | 'circle-slash' | 'circle-large-outline' | 'check'> = {
  passed: 'pass',
  failed: 'error',
  skipped: 'circle-slash',
  'not-run': 'circle-large-outline',
  'by-hand': 'check',
};

export function RunsSheet({
  runsKey,
  title,
  visible,
  onClose,
}: {
  /** Whose runs (runLogKey). */
  runsKey: string | undefined;
  title: string;
  visible: boolean;
  onClose(): void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {visible ? <RunsBody runsKey={runsKey} title={title} onClose={onClose} /> : null}
    </Modal>
  );
}

/** The sheet's content, made when it opens (so its clock starts then). */
function RunsBody({ runsKey, title, onClose }: { runsKey: string | undefined; title: string; onClose(): void }) {
  const styles = useStyles();
  const colors = usePalette();
  const runs = useRunLog(runsKey);
  const [open, setOpen] = useState<number | undefined>();
  const newest = [...runs].reverse();
  const green = lastGreen(runs);
  // Ticks while the sheet is open ("just now" turns into minutes).
  const now = useNow(true, 30_000);
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.close} />
      <View testID="runs-sheet" style={styles.sheet}>
        <Grabber onClose={onClose} />
        <Text style={styles.title} role="heading" numberOfLines={2}>
          {t.runsTitle(title)}
        </Text>
        {runs.length === 0 ? (
          <View testID="runs-empty">
            <Text style={styles.headline}>{t.runsEmpty}</Text>
            <Points items={t.runsEmptyPoints} textStyle={styles.detail} />
          </View>
        ) : (
          <>
            <Text testID="runs-last-green" style={styles.sub}>
              {green ? t.runsLastGreen(ago(green.ended, now), green.by) : t.runsNeverGreen}
            </Text>
            <ScrollView>
              {newest.map((r, i) => {
                const failed = r.steps.some((s) => s.state === 'failed');
                const expanded = open === r.started;
                return (
                  <View key={`${r.started}-${i}`} style={[styles.run, i > 0 && styles.runBorder]}>
                    <Pressable
                      testID={`run-${i}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      aria-expanded={expanded}
                      onPress={() => setOpen(expanded ? undefined : r.started)}
                      style={({ pressed }) => [styles.runHead, pressed && styles.pressed]}
                    >
                      <Codicon
                        name={failed ? 'error' : r.green ? 'pass-filled' : 'circle-large-outline'}
                        size={18}
                        color={failed ? colors.error : r.green ? colors.ok : colors.muted}
                      />
                      <View style={styles.runText}>
                        <Text testID={`run-${i}-headline`} style={styles.headline} numberOfLines={2}>
                          {runHeadline(r)}
                        </Text>
                        <Text style={styles.detail}>
                          {`${formatWhen(r.started, now)} · ${formatEstimate(Math.max(0, r.ended - r.started) / 1000)}`}
                        </Text>
                        <Text testID={`run-${i}-detail`} style={styles.detail}>
                          {runDetail(r)}
                        </Text>
                      </View>
                      <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} color={colors.muted} />
                    </Pressable>
                    {expanded ? (
                      <View testID={`run-${i}-steps`} style={styles.steps}>
                        {r.steps.map((s, k) => (
                          <View key={k} style={styles.step}>
                            <Codicon
                              name={ICON[s.state]}
                              size={14}
                              color={s.state === 'failed' ? colors.error : s.state === 'passed' ? colors.ok : colors.muted}
                            />
                            <Text style={styles.stepLabel} numberOfLines={2}>
                              {s.label}
                            </Text>
                            <Text style={styles.detail}>
                              {t.runStepState[s.state]}
                              {s.ms !== undefined ? ` · ${formatEstimate(s.ms / 1000)}` : ''}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              <Text style={[styles.detail, styles.footer]}>{t.runsKept}</Text>
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: c.scrim },
  sheet: {
    maxHeight: '80%',
    backgroundColor: c.sheet,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 14,
    paddingBottom: 28,
  },
  title: { fontSize: 17, fontWeight: '600', color: c.text },
  sub: { fontSize: 13, color: c.muted, marginTop: 2, marginBottom: 8 },
  run: { paddingVertical: 4 },
  runBorder: { borderTopWidth: 1, borderTopColor: c.border },
  runHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 6, borderRadius: 6 },
  pressed: { backgroundColor: c.codeBackground },
  runText: { flex: 1 },
  headline: { fontSize: 15, color: c.text, marginTop: 6 },
  detail: { fontSize: 13, color: c.muted, marginTop: 2, lineHeight: 18 },
  steps: { paddingLeft: 28, paddingBottom: 6, gap: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stepLabel: { flexShrink: 1, fontSize: 14, color: c.text },
  footer: { marginTop: 12 },
}));

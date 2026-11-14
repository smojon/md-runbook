/**
 * The Steps view, as VS Code's: a header with where the run is (the run bar's words, the bar, the
 * share and the time left), its buttons (Retry step and Resume after a failure; on a phone also
 * Run all or Stop) and, before a run, what the steps will need (each count goes to the first step
 * that needs it, or opens Set Inputs); then every step by name (StepsList). A phone shows it as
 * its Steps tab, a wide screen as the side panel beside the runbook.
 */
import { Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import type { PreflightPart, StepsRow } from '../runbooks/steps';
import { themedStyles } from '../theme';
import { StepsAnswers, StepsList } from './StepsList';
import { TimeBar } from './TimeBar';

/** A button of the header: `steps-<id>`. */
export interface StepsHeadAction {
  id: 'retry' | 'resume' | 'run' | 'stop';
  label: string;
  hint?: string;
  kind: 'primary' | 'secondary' | 'stop';
  onPress(): void;
}

/** Where the run is, as the run bar says it: its headline, the share done and the time left. */
export interface StepsHeader {
  headline: string;
  /** The run waits for an answer (amber), or a step failed (red). */
  tone?: 'waiting' | 'failed';
  /** `41% · 4 min left · ends ≈ 14:32`, with estimates. */
  line?: string;
  fraction?: number;
  /** Before a run: what the steps still to do will need, count by count (each one a button). */
  preflight?: readonly PreflightPart[];
  actions?: readonly StepsHeadAction[];
  /** What the last run said (stopped at a failed step, a host missing): as under the run bar. */
  notice?: string;
}

export function StepsHead({ header, onPreflight }: { header: StepsHeader; onPreflight?(part: PreflightPart): void }) {
  const styles = useStyles();
  const parts = header.preflight ?? [];
  return (
    <View style={styles.head}>
      <Text
        testID="steps-headline"
        accessibilityRole="header"
        style={[styles.headline, header.tone === 'waiting' && styles.waiting, header.tone === 'failed' && styles.failed]}
        numberOfLines={2}
      >
        {header.headline}
      </Text>
      {header.actions?.length ? (
        <View style={styles.actions}>
          {header.actions.map((a) => (
            <Pressable
              key={a.id}
              testID={`steps-${a.id}`}
              accessibilityRole="button"
              {...(a.hint ? { accessibilityHint: a.hint } : {})}
              onPress={a.onPress}
              style={({ pressed }) => [
                a.kind === 'secondary' ? styles.secondary : styles.primary,
                a.kind === 'stop' && styles.stop,
                pressed && styles.pressed,
              ]}
            >
              <Text style={a.kind === 'secondary' ? styles.secondaryText : styles.primaryText}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {header.fraction !== undefined ? (
        <View style={styles.bar}>
          <TimeBar fraction={header.fraction} />
        </View>
      ) : null}
      {header.line ? (
        <Text testID="steps-progress" style={styles.sub}>
          {header.line}
        </Text>
      ) : null}
      {parts.length ? (
        // Each count is a button: it goes to the first step that needs it, or opens where it is set.
        <View testID="steps-preflight" style={styles.preflight}>
          <Text style={styles.preflightText}>{t.preflight('')}</Text>
          {parts.map((p, i) => (
            <View key={p.kind} style={styles.part}>
              {i > 0 ? <Text style={styles.preflightText}>{' · '}</Text> : null}
              <Pressable
                testID={`steps-preflight-${p.kind}`}
                accessibilityRole="button"
                accessibilityHint={
                  p.kind === 'input' ? t.preflightInputsHint : p.kind === 'secret' ? t.preflightSecretsHint : t.preflightGoHint
                }
                onPress={() => onPreflight?.(p)}
                hitSlop={8}
              >
                {({ pressed }) => <Text style={[styles.preflightLink, pressed && styles.pressed]}>{p.text}</Text>}
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {header.notice ? (
        <Text testID="steps-notice" role="alert" style={styles.notice}>
          {header.notice}
        </Text>
      ) : null}
    </View>
  );
}

export function StepsView({
  testID,
  header,
  rows,
  visible,
  answers,
  onGo,
  onActions,
  onTick,
  onPreflight,
}: {
  testID?: string;
  header: StepsHeader;
  rows: readonly StepsRow[];
  /** The cells on screen. */
  visible?: { first: number; last: number };
  /** The question the run waits at, if any: on the row that waits. */
  answers: StepsAnswers | undefined;
  onGo(index: number): void;
  onActions?(index: number): void;
  onTick?(index: number, item: number, checked: boolean): void;
  onPreflight?(part: PreflightPart): void;
}) {
  const styles = useStyles();
  return (
    <View testID={testID} style={styles.view}>
      <StepsHead header={header} {...(onPreflight ? { onPreflight } : {})} />
      <StepsList
        rows={rows}
        {...(visible ? { visible } : {})}
        {...(answers ? { answers } : {})}
        onGo={onGo}
        {...(onActions ? { onActions } : {})}
        {...(onTick ? { onTick } : {})}
      />
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  view: { flex: 1 },
  head: { paddingVertical: 8, paddingHorizontal: 2, borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: 4 },
  headline: { fontSize: 15, fontWeight: '600', color: c.text },
  waiting: { color: c.warningText },
  failed: { color: c.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 8 },
  primary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 20, backgroundColor: c.accent },
  stop: { backgroundColor: c.error },
  primaryText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  secondary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10 },
  secondaryText: { fontSize: 15, color: c.link },
  pressed: { opacity: 0.6 },
  bar: { flexDirection: 'row', marginTop: 8 },
  sub: { fontSize: 13, color: c.muted, marginTop: 4 },
  preflight: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  part: { flexDirection: 'row', alignItems: 'center' },
  preflightText: { fontSize: 13, color: c.warningText },
  preflightLink: { fontSize: 13, color: c.link, textDecorationLine: 'underline', paddingVertical: 4 },
  notice: { fontSize: 13, color: c.error, marginTop: 6 },
}));

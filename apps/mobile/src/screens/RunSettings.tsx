/**
 * Hosts & settings: the extension's safety settings for runs. The risky-command patterns (shown in
 * Asking before a cell runs), Running cells (a cell's timeout when it has none, whether Run all
 * stops at a failed step, and whether each run records where it ran) and Hiding secrets in output (patterns added to the built-in ones). A
 * list of patterns is edited row by row: Add checks the pattern compiles, × removes one.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_CONFIRM_PATTERNS } from '@md-runbook/core/confirm';
import { t } from '../i18n';
import { PatternKind, patternProblem } from '../settings/safety';
import {
  TIMEOUTS,
  setConfirmPatterns,
  setOutputSetting,
  setRedactionPatterns,
  setTimeoutSeconds,
  useOutputSettings,
} from '../settings/store';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';
import { Points } from '../ui/Points';
import { Toggle } from '../ui/Toggle';

/** A list of regular expressions: each with ×, a field and Add (the pattern must compile). */
function PatternList({
  kind,
  patterns,
  placeholder,
  empty,
  onChange,
}: {
  kind: PatternKind;
  patterns: readonly string[];
  placeholder: string;
  empty: string;
  onChange(next: readonly string[]): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const add = (): void => {
    const problem = patternProblem(kind, draft, patterns);
    if (problem) {
      setError(
        problem.kind === 'empty' ? t.patternEmpty : problem.kind === 'duplicate' ? t.patternDuplicate : t.patternInvalid(problem.why),
      );
      return;
    }
    setError(undefined);
    setDraft('');
    onChange([...patterns, draft]);
  };
  return (
    <View testID={`${kind}-patterns`}>
      {patterns.length === 0 ? <Text style={styles.help}>{empty}</Text> : null}
      {patterns.map((p, i) => (
        <View key={p} style={styles.patternRow}>
          <Text testID={`${kind}-pattern-${i}`} style={styles.pattern} selectable>
            {p}
          </Text>
          <Pressable
            testID={`${kind}-pattern-${i}-remove`}
            accessibilityRole="button"
            accessibilityLabel={t.patternRemove(p)}
            hitSlop={8}
            onPress={() => onChange(patterns.filter((x) => x !== p))}
            style={styles.remove}
          >
            <Codicon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
      ))}
      <View style={styles.addRow}>
        <TextInput
          testID={`${kind}-pattern-new`}
          accessibilityLabel={t.patternNew}
          style={[styles.input, styles.addInput]}
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            setError(undefined);
          }}
          onSubmitEditing={add}
          placeholder={placeholder}
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        <Pressable testID={`${kind}-pattern-add`} accessibilityRole="button" onPress={add} style={styles.button}>
          <Text style={styles.buttonText}>{t.patternAdd}</Text>
        </Pressable>
      </View>
      {error ? (
        <Text testID={`${kind}-pattern-error`} role="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** The risky commands (mdRunbook.execution.confirmPatterns), with a way back to VS Code's defaults. */
export function ConfirmPatternsSetting() {
  const styles = useStyles();
  const s = useOutputSettings();
  const patterns = s.confirmPatterns ?? DEFAULT_CONFIRM_PATTERNS;
  return (
    <View style={styles.block}>
      <Text style={styles.switchLabel}>{t.confirmPatternsLabel}</Text>
      <Points items={t.confirmPatternsPoints} textStyle={styles.help} />
      <PatternList
        kind="confirm"
        patterns={patterns}
        placeholder={t.confirmPatternPlaceholder}
        empty={t.confirmPatternsNone}
        onChange={(next) => setConfirmPatterns(next)}
      />
      {s.confirmPatterns !== undefined ? (
        <Pressable
          testID="confirm-patterns-reset"
          accessibilityRole="button"
          onPress={() => setConfirmPatterns(undefined)}
          hitSlop={6}
          style={styles.reset}
        >
          <Text style={styles.link}>{t.patternsReset}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A cell's timeout when it has none, and whether Run all stops at a failed step. */
export function RunningSection() {
  const styles = useStyles();
  const s = useOutputSettings();
  return (
    <View testID="running-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.runningTitle}</Text>
      <Text style={styles.switchLabel}>{t.timeoutLabel}</Text>
      <Points items={t.timeoutPoints} textStyle={styles.help} />
      <View style={styles.chips}>
        {TIMEOUTS.map((n) => (
          <Pressable
            key={n}
            testID={`timeout-${n}`}
            accessibilityRole="button"
            accessibilityState={{ selected: n === s.timeoutSeconds }}
            onPress={() => setTimeoutSeconds(n)}
            style={[styles.chip, n === s.timeoutSeconds && styles.chipOn]}
          >
            <Text style={[styles.chipText, n === s.timeoutSeconds && styles.chipTextOn]}>{t.timeoutChip(n)}</Text>
          </Pressable>
        ))}
        {/* A value set elsewhere (VS Code's setting is any number): shown, selected. */}
        {!(TIMEOUTS as readonly number[]).includes(s.timeoutSeconds) ? (
          <View testID="timeout-other" style={[styles.chip, styles.chipOn]}>
            <Text style={[styles.chipText, styles.chipTextOn]}>{t.timeoutChip(s.timeoutSeconds)}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.stopOnFailure}</Text>
          <Points items={t.stopOnFailurePoints} textStyle={styles.help} />
        </View>
        <Toggle
          testID="setting-stopOnFailure"
          accessibilityLabel={t.stopOnFailure}
          value={s.stopOnFailure}
          onValueChange={(on) => setOutputSetting('stopOnFailure', on)}
        />
      </View>
      {/* The extension's mdRunbook.output.recordContext, for a host: its Kubernetes context and the account. */}
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.recordContext}</Text>
          <Points items={t.recordContextPoints} textStyle={styles.help} />
        </View>
        <Toggle
          testID="setting-recordContext"
          accessibilityLabel={t.recordContext}
          value={s.recordContext}
          onValueChange={(on) => setOutputSetting('recordContext', on)}
        />
      </View>
    </View>
  );
}

/** Patterns redacted from output, besides the built-in ones (mdRunbook.redaction.patterns). */
export function RedactionSection() {
  const styles = useStyles();
  const s = useOutputSettings();
  return (
    <View testID="redaction-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.redactionTitle}</Text>
      <Points items={t.redactionPoints} textStyle={styles.help} />
      <Text style={styles.label}>{t.redactionPatternsLabel}</Text>
      <PatternList
        kind="redaction"
        patterns={s.redactionPatterns}
        placeholder={t.redactionPatternPlaceholder}
        empty={t.redactionPatternsNone}
        onChange={setRedactionPatterns}
      />
    </View>
  );
}

// As the other settings' cards (HostList.tsx).
const useStyles = themedStyles((colors) => ({
  section: {
    marginTop: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  block: { paddingVertical: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  help: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 4 },
  label: { fontSize: 13, color: colors.muted, marginTop: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, marginTop: 8 },
  switchText: { flex: 1 },
  switchLabel: { fontSize: 15, color: colors.text },
  patternRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pattern: { flex: 1, fontFamily: mono, fontSize: 13, color: colors.text },
  remove: { padding: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.background,
    padding: 10,
    fontSize: 14,
    fontFamily: mono,
    color: colors.text,
  },
  addInput: { flex: 1 },
  button: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.accent },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  reset: { alignSelf: 'flex-start', marginTop: 8, minHeight: 32, justifyContent: 'center' },
  link: { fontSize: 15, color: colors.link },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: colors.onAccent },
}));

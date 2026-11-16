/**
 * The launch form (runbooks/launch.ts), as VS Code's Steps view shows it before a Run All: one
 * sheet with the parameters (a choice per value when the runbook lists them), the inputs, the
 * secrets not stored yet (Set each, here), the risky steps with their commands, the steps by hand,
 * the time and where it runs. Start runs with these values; Back closes it.
 */
import { ReactNode, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import type { LaunchError, LaunchModel } from '../runbooks/launch';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from './Codicon';
import { Grabber } from './Grabber';

export interface LaunchTyped {
  params: Record<string, string>;
  inputs: Record<string, string>;
}

export function LaunchSheet(p: {
  model: LaunchModel;
  /** The runbook's title. */
  title: string;
  /** `deploy@web-1`: the host the run goes to. */
  runsOn?: string;
  /** Why Start didn't start (a field to fix). */
  error?: LaunchError;
  onStart(typed: LaunchTyped): void;
  onBack(): void;
  onGo(index: number): void;
  onSetSecret(name: string, value: string): void;
}) {
  const styles = useStyles();
  const c = usePalette();
  const m = p.model;
  const [params, setParams] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const paramValue = (name: string, start?: string): string => params[name] ?? start ?? '';
  const errorOf = (field: string): string | undefined => {
    const e = p.error;
    if (!e || e.field !== field) return undefined;
    return e.kind === 'choice' ? t.launchChoose(e.name, m.params.find((x) => x.name === e.name)?.choices ?? []) : t.launchMissing(e.name);
  };
  const missing = m.secrets.filter((s) => !s.stored).map((s) => s.name);
  const where = [...(p.runsOn ? [t.launchRunsOn(p.runsOn)] : []), ...(m.kubeContext ? [t.launchKube(m.kubeContext)] : [])];
  const stepLink = (x: { index: number; step?: number; label: string }, testID: string): ReactNode => (
    <Pressable testID={testID} accessibilityRole="link" accessibilityHint={t.launchGoHint} onPress={() => p.onGo(x.index)} hitSlop={4}>
      {({ pressed }) => <Text style={[styles.link, pressed && styles.pressed]}>{t.launchStep(x.step, x.label)}</Text>}
    </Pressable>
  );
  return (
    <Modal visible animationType="slide" transparent onRequestClose={p.onBack}>
      <Pressable style={styles.backdrop} onPress={p.onBack} accessibilityLabel={t.close} />
      <View testID="launch-sheet" style={styles.sheet}>
        <Grabber onClose={p.onBack} />
        <Text testID="launch-title" accessibilityRole="header" style={styles.title}>
          {t.launchTitle}
        </Text>
        <Text testID="launch-sub" style={styles.sub}>
          {[p.title, m.time].filter(Boolean).join(' · ')}
        </Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
          {m.params.length === 0 && m.inputs.length === 0 && m.secrets.length === 0 ? (
            <Text style={styles.desc}>{t.launchNothing}</Text>
          ) : null}
          {m.params.length > 0 ? (
            <Section title={t.launchParams}>
              {m.params.map((x) => {
                const desc = [
                  x.description ?? '',
                  x.default !== undefined && x.from !== 'default' ? t.launchDefault(x.default) : '',
                  x.from === 'typed' ? t.launchTyped : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                const err = errorOf(`param:${x.name}`);
                const now = paramValue(x.name, x.choices && x.value !== undefined && !x.choices.includes(x.value) ? '' : x.value);
                return (
                  <View key={x.name} style={styles.field}>
                    <Text style={styles.name}>{x.name}</Text>
                    {desc ? <Text style={styles.desc}>{desc}</Text> : null}
                    {x.choices ? (
                      <View testID={`launch-param-${x.name}`} accessibilityRole="radiogroup" style={styles.chips}>
                        {x.choices.map((choice) => (
                          <Pressable
                            key={choice}
                            testID={`launch-param-${x.name}-${choice}`}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: now === choice }}
                            onPress={() => setParams((v) => ({ ...v, [x.name]: choice }))}
                            style={[styles.chip, now === choice && styles.chipOn]}
                          >
                            <Text style={[styles.chipText, now === choice && styles.chipTextOn]}>{choice}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <TextInput
                        testID={`launch-param-${x.name}`}
                        accessibilityLabel={x.name}
                        style={[styles.input, err !== undefined && styles.inputError]}
                        value={now}
                        onChangeText={(v) => setParams((all) => ({ ...all, [x.name]: v }))}
                        placeholder={x.default}
                        placeholderTextColor={c.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    )}
                    {err ? (
                      <Text testID={`launch-error-param-${x.name}`} role="alert" style={styles.error}>
                        {err}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </Section>
          ) : null}
          {m.inputs.length > 0 ? (
            <Section title={t.launchInputs}>
              {m.inputs.map((x) => (
                <View key={x.name} style={styles.field}>
                  <Text style={styles.name}>{x.name}</Text>
                  {x.secret ? <Text style={styles.desc}>{t.launchSecretInput}</Text> : null}
                  <TextInput
                    testID={`launch-input-${x.name}`}
                    accessibilityLabel={x.name}
                    style={styles.input}
                    value={inputs[x.name] ?? (x.secret ? '' : (x.value ?? ''))}
                    onChangeText={(v) => setInputs((all) => ({ ...all, [x.name]: v }))}
                    secureTextEntry={x.secret}
                    {...(x.secret
                      ? { placeholder: x.set ? t.launchSecretSet : t.launchSecretEmpty, placeholderTextColor: c.placeholder }
                      : {})}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              ))}
            </Section>
          ) : null}
          {m.secrets.length > 0 ? (
            <Section title={t.launchSecrets} note={t.launchSecretsNote}>
              {m.secrets.map((s) => (
                <View key={s.name} testID={`launch-secret-${s.name}`} style={styles.secret}>
                  <View style={styles.secretHead}>
                    <Codicon name="key" size={13} color={c.muted} />
                    <Text style={styles.name}>{s.name}</Text>
                    <Text testID={`launch-secret-${s.name}-state`} style={styles.desc}>
                      {s.stored ? t.launchStored : t.launchNotStored}
                    </Text>
                  </View>
                  {s.stored ? null : (
                    <View style={styles.secretSet}>
                      <TextInput
                        testID={`launch-secret-${s.name}-value`}
                        accessibilityLabel={s.name}
                        style={[styles.input, styles.secretInput]}
                        value={secrets[s.name] ?? ''}
                        onChangeText={(v) => setSecrets((all) => ({ ...all, [s.name]: v }))}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <Pressable
                        testID={`launch-secret-${s.name}-set`}
                        accessibilityRole="button"
                        accessibilityLabel={`${t.launchSet} ${s.name}`}
                        accessibilityHint={t.launchSetHint(s.name)}
                        accessibilityState={{ disabled: !secrets[s.name] }}
                        disabled={!secrets[s.name]}
                        onPress={() => {
                          p.onSetSecret(s.name, secrets[s.name]!);
                          setSecrets((all) => ({ ...all, [s.name]: '' }));
                        }}
                        style={[styles.setButton, !secrets[s.name] && styles.disabled]}
                      >
                        <Text style={styles.link}>{t.launchSet}</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
              {missing.length > 0 ? (
                <Text testID="launch-missing" style={styles.warn}>
                  {t.launchMissingSecrets(missing)}
                </Text>
              ) : null}
            </Section>
          ) : null}
          {m.risky.length > 0 ? (
            <Section title={t.launchRisky} note={t.launchRiskyNote}>
              {m.risky.map((r) => (
                <View key={r.index} testID={`launch-risky-${r.index}`} style={styles.item}>
                  {stepLink(r, `launch-go-${r.index}`)}
                  {r.match ? <Text style={styles.desc}>{t.launchMatches(r.match)}</Text> : null}
                  <Text style={styles.cmd}>{[...r.lines, ...(r.more ? [t.launchMore(r.more)] : [])].join('\n')}</Text>
                </View>
              ))}
            </Section>
          ) : null}
          {m.byHand.length > 0 ? (
            <Section title={t.launchByHand} note={m.byHandWaits ? t.launchByHandWaits : t.launchByHandGoes}>
              {m.byHand.map((b, n) => (
                <View key={`${b.index}-${n}`} style={styles.item}>
                  {stepLink(b, `launch-hand-${b.index}-${n}`)}
                </View>
              ))}
            </Section>
          ) : null}
          {where.length > 0 ? (
            <Section title={t.launchContext}>
              {where.map((w) => (
                <Text key={w} style={styles.desc}>
                  {w}
                </Text>
              ))}
            </Section>
          ) : null}
        </ScrollView>
        <View style={styles.foot}>
          <Pressable
            testID="launch-start"
            accessibilityRole="button"
            accessibilityHint={t.launchStartHint}
            onPress={() => p.onStart({ params, inputs })}
            style={({ pressed }) => [styles.start, pressed && styles.pressed]}
          >
            <Codicon name="run-all" size={14} color={c.onAccent} />
            <Text style={styles.startText}>{t.launchStart}</Text>
          </Pressable>
          <Pressable testID="launch-back" accessibilityRole="button" onPress={p.onBack} style={styles.back}>
            <Text style={styles.link}>{t.launchBack}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.legend}>
        {title}
      </Text>
      {note ? <Text style={styles.desc}>{note}</Text> : null}
      {children}
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: c.scrim },
  sheet: {
    maxHeight: '88%',
    backgroundColor: c.sheet,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 14,
    paddingBottom: 24,
  },
  title: { fontSize: 18, fontWeight: '600', color: c.text },
  sub: { fontSize: 13, color: c.muted, marginTop: 2, marginBottom: 6 },
  body: { paddingBottom: 8 },
  section: { marginTop: 14, gap: 6 },
  legend: { fontSize: 12, fontWeight: '600', color: c.muted, textTransform: 'uppercase' },
  field: { gap: 4, marginTop: 4 },
  name: { fontSize: 15, fontWeight: '600', color: c.text, fontFamily: mono },
  desc: { fontSize: 13, color: c.muted, lineHeight: 18 },
  warn: { fontSize: 13, color: c.warningText, lineHeight: 18 },
  error: { fontSize: 13, color: c.error },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 16,
    color: c.text,
  },
  inputError: { borderColor: c.error },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: c.border },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { fontSize: 15, color: c.text },
  chipTextOn: { color: c.onAccent },
  secret: { gap: 4, marginTop: 4 },
  secretHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  secretSet: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  secretInput: { flex: 1 },
  setButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10 },
  disabled: { opacity: 0.4 },
  item: { gap: 2, marginTop: 4 },
  link: { fontSize: 15, color: c.link },
  cmd: { fontFamily: mono, fontSize: 13, color: c.text, backgroundColor: c.codeBackground, padding: 8, borderRadius: 6, marginTop: 2 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  start: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: c.accent,
  },
  startText: { fontSize: 16, fontWeight: '600', color: c.onAccent },
  back: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  pressed: { opacity: 0.6 },
}));

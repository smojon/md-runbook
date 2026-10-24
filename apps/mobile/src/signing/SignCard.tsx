/**
 * Sign Runbook and Co-sign Runbook at the top of a runbook: what the extension asks in its input
 * boxes (a name and scopes the first time, how long it stays valid, a pattern for each value a
 * signed cell uses), or for co-signing what is being reviewed. The app's key signs.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import type { Manifest, SignatureBlock } from '@md-runbook/core/signing';
import { SIGNER_NAME_RE, signerNames } from '@md-runbook/core/signing';
import { t } from '../i18n';
import { setSignerName, useSignerName } from '../settings/store';
import { mono, themedStyles, usePalette } from '../theme';
import { SignInput, SignPlan, checkSignInput } from './sign';

export type SignRequest = { kind: 'sign'; plan: SignPlan } | { kind: 'cosign'; block: SignatureBlock; manifest: Manifest };

export function SignCard({
  request,
  busy,
  errors,
  onSign,
  onCancel,
}: {
  request: SignRequest;
  /** Signing: the key signs (inside the phone's secure hardware); the card waits. */
  busy: boolean;
  /** What the core refused (a cell that can't be signed, …). */
  errors: readonly string[];
  onSign(input: SignInput | undefined, signer: string): void;
  onCancel(): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  // The saved name until one is typed (settings may load after the card opens).
  const saved = useSignerName();
  const [typed, setSigner] = useState<string | undefined>();
  const signer = typed ?? saved;
  const [input, setInput] = useState<SignInput>(() => ({
    name: request.kind === 'sign' ? request.plan.name : '',
    scopes: '',
    days: '',
    patterns: {},
  }));
  const [tried, setTried] = useState(false);
  const bad = new Set([
    ...(request.kind === 'sign' ? checkSignInput(request.plan, input) : []),
    ...(SIGNER_NAME_RE.test(signer.trim()) ? [] : ['signer']),
  ]);
  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; hint?: string; numeric?: boolean } = {},
  ) => (
    <View key={id} style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={`sign-${id}`}
        accessibilityLabel={label}
        style={[styles.input, tried && bad.has(id) && styles.inputBad]}
        value={value}
        onChangeText={onChange}
        placeholder={opts.placeholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={opts.numeric ? 'number-pad' : 'default'}
        editable={!busy}
      />
      {opts.hint ? <Text style={styles.hint}>{opts.hint}</Text> : null}
    </View>
  );
  const go = (): void => {
    setTried(true);
    if (bad.size > 0) return;
    setSignerName(signer);
    onSign(request.kind === 'sign' ? input : undefined, signer.trim());
  };
  const plan = request.kind === 'sign' ? request.plan : undefined;
  return (
    <View testID="sign-card" style={styles.card}>
      {plan ? (
        <>
          <Text style={styles.title}>{plan.previous ? t.signAgainTitle(plan.previous.name, plan.version) : t.signTitle}</Text>
          <Text style={styles.body}>{t.signBody}</Text>
          {plan.previous
            ? null
            : [
                field('name', t.signName, input.name, (v) => setInput({ ...input, name: v }), { hint: t.signNameHint }),
                field('scopes', t.signScopes, input.scopes, (v) => setInput({ ...input, scopes: v }), {
                  placeholder: 'prod eu',
                  hint: t.signScopesHint,
                }),
              ]}
          {field('days', t.signDays, input.days, (v) => setInput({ ...input, days: v }), {
            placeholder: '30',
            hint: t.signDaysHint,
            numeric: true,
          })}
          {plan.needs.map((n) =>
            field(
              `pattern:${n.name}`,
              t.signPattern(n.kind, n.name),
              input.patterns[n.name] ?? '',
              (v) => setInput({ ...input, patterns: { ...input.patterns, [n.name]: v } }),
              { placeholder: '[a-z0-9-]{1,32}', hint: t.signPatternHint },
            ),
          )}
        </>
      ) : request.kind === 'cosign' ? (
        <>
          <Text style={styles.title}>{t.cosignTitle(request.manifest.name, request.manifest.version)}</Text>
          <Text testID="cosign-summary" style={styles.body}>
            {t.cosignBody(signerNames(request.block).join(', '), request.manifest.cells.length)}
          </Text>
          {request.manifest.cells.map((c) => (
            <Text key={c.n} style={styles.code} numberOfLines={3}>
              {c.code}
            </Text>
          ))}
        </>
      ) : null}
      {field('signer', t.signerName, signer, setSigner, {
        placeholder: t.signerPlaceholder,
        ...(tried && bad.has('signer') ? { hint: t.signerNameRule } : {}),
      })}
      {errors.map((e) => (
        <Text key={e} testID="sign-error" style={styles.error}>
          {e}
        </Text>
      ))}
      <View style={styles.actions}>
        <Pressable
          testID="sign-go"
          accessibilityRole="button"
          disabled={busy}
          onPress={go}
          style={[styles.button, busy && styles.disabled]}
        >
          {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.buttonText}>{plan ? t.signGo : t.cosignGo}</Text>}
        </Pressable>
        <Pressable
          testID="sign-cancel"
          accessibilityRole="button"
          disabled={busy}
          onPress={onCancel}
          style={[styles.secondary, busy && styles.disabled]}
        >
          <Text style={styles.secondaryText}>{t.cancel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.accent, borderRadius: 8, padding: 12, marginVertical: 8 },
  title: { fontSize: 16, color: c.text, marginBottom: 6 },
  body: { fontSize: 13, color: c.muted, lineHeight: 18, marginBottom: 4 },
  field: { marginTop: 8 },
  label: { fontSize: 13, color: c.muted, marginBottom: 2 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, fontSize: 15, color: c.text },
  inputBad: { borderColor: c.error },
  hint: { fontSize: 12, color: c.muted, marginTop: 2 },
  code: { fontFamily: mono, fontSize: 12, color: c.text, backgroundColor: c.codeBackground, padding: 6, borderRadius: 4, marginTop: 4 },
  error: { fontSize: 13, color: c.error, marginTop: 8 },
  actions: { flexDirection: 'row', gap: 12, alignItems: 'center', marginTop: 12 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent, minWidth: 90, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: c.link },
}));

/**
 * Approving a proposed cell, with the extension's command policy (core/policy): what it runs, who
 * proposed it and why, the commands that are not on the allowlist, the fence options that change
 * how it runs, and the account it will run as. A denied cell can't be approved; one that needs a
 * review is approved by typing `run`.
 */
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { tokenizeInfo } from '@md-runbook/core/cellOptions';
import type { PolicyResult } from '@md-runbook/core/policy';
import { t } from '../i18n';
import { mono, themedStyles, usePalette } from '../theme';

/** Options that change how a cell runs (the extension lists the same in its review dialog). */
const RUN_OPTIONS =
  /^(no-confirm|cwd|timeout|continue-on-error|retry|every|expect|expect-not|expect-exit|capture|capture-secret|host|env\..+)$/i;

export function runOptionsOf(info: string): string[] {
  const rest = info.replace(/^\s*\S+/, '');
  return tokenizeInfo(rest)
    .filter((tk) => RUN_OPTIONS.test(tk.key))
    .map((tk) => rest.slice(tk.start, tk.end));
}

export function ApproveCard(p: {
  code: string;
  info: string;
  by: string;
  reason?: string;
  result: PolicyResult;
  typed: boolean;
  runsAs?: string;
  onApprove(): void;
  onReject(): void;
  onCancel(): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  const [word, setWord] = useState('');
  const denied = p.result.denied[0];
  const options = runOptionsOf(p.info);
  const needsWord = p.result.verdict === 'review' && p.typed;
  const can = !denied && (!needsWord || word.trim().toLowerCase() === 'run');
  return (
    <View testID="approve-card" style={styles.card}>
      <Text style={styles.title}>{t.approveTitle(p.by)}</Text>
      {p.reason ? <Text style={styles.body}>{t.approveReason(p.reason)}</Text> : null}
      <Text testID="approve-code" style={styles.code} selectable>
        {p.code}
      </Text>
      {denied ? (
        <Text testID="approve-denied" style={styles.warning}>
          {t.approveDenied(denied.line, denied.pattern)}
        </Text>
      ) : null}
      {!denied && p.result.unlisted.length > 0 ? (
        <View>
          <Text style={styles.body}>{p.result.zsh ? t.approveZsh : t.approveUnlisted}</Text>
          {p.result.unlisted.map((l) => (
            <Text key={l} style={styles.code}>
              {l}
            </Text>
          ))}
        </View>
      ) : null}
      {options.length > 0 ? (
        <Text style={styles.body}>
          {t.approveOptions} {options.join(' ')}
        </Text>
      ) : null}
      {p.runsAs ? <Text style={styles.body}>{t.approveRunsAs(p.runsAs)}</Text> : null}
      {needsWord && !denied ? (
        <TextInput
          testID="approve-word"
          accessibilityLabel={t.approveTypeRun}
          placeholder={t.approveTypeRun}
          placeholderTextColor={colors.placeholder}
          style={styles.input}
          value={word}
          onChangeText={setWord}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}
      <View style={styles.actions}>
        <Pressable
          testID="approve-confirm"
          accessibilityRole="button"
          disabled={!can}
          onPress={p.onApprove}
          style={[styles.button, !can && styles.disabled]}
        >
          <Text style={styles.buttonText}>{t.approve}</Text>
        </Pressable>
        <Pressable testID="approve-reject" accessibilityRole="button" onPress={p.onReject} style={styles.secondary}>
          <Text style={styles.danger}>{t.reject}</Text>
        </Pressable>
        <Pressable testID="approve-cancel" accessibilityRole="button" onPress={p.onCancel} style={styles.secondary}>
          <Text style={styles.link}>{t.trustDecline}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.warning, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  code: { fontFamily: mono, fontSize: 13, color: c.text, backgroundColor: c.codeBackground, padding: 6, borderRadius: 4 },
  warning: { fontSize: 13, color: c.error },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, fontSize: 15, color: c.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  disabled: { opacity: 0.5 },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  danger: { fontSize: 15, color: c.error },
  link: { fontSize: 15, color: c.link },
}));

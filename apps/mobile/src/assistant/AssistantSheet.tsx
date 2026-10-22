/**
 * The assistant's one sheet, step by step as in the extension: the API key the first time, then
 * what is about to be sent (size, pseudonymized names, the leak check, lines that look like
 * injected instructions, and a preview of the exact text), the wait, and the answer. Nothing is
 * sent without Send; nothing an answer contains runs (suggestions arrive as proposed cells).
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { LeakFinding } from '@md-runbook/core/leaks';
import { t } from '../i18n';
import { MarkdownView } from '../markdown/MarkdownView';
import { mono, themedStyles, usePalette } from '../theme';

export type AssistantStep =
  | { kind: 'key' }
  | { kind: 'confirm'; what: string; chars: number; text: string; leaks: readonly LeakFinding[]; warnings: readonly string[]; send: string }
  | { kind: 'busy'; what: string }
  | { kind: 'answer'; title: string; markdown: string; canInsert: boolean }
  | { kind: 'leaks'; leaks: readonly LeakFinding[] };

export function AssistantSheet(p: {
  step: AssistantStep | undefined;
  onKey(key: string): void;
  onSend(): void;
  onInsert(): void;
  onClose(): void;
}) {
  const styles = useStyles();
  const colors = usePalette();
  const [key, setKey] = useState('');
  const [preview, setPreview] = useState(false);
  const s = p.step;
  const close = (): void => {
    setPreview(false);
    setKey('');
    p.onClose();
  };
  const leakList = (leaks: readonly LeakFinding[]) =>
    leaks.slice(0, 20).map((f, i) => (
      <Text key={i} style={styles.leak}>
        {t.leakLine(f.line, f.kind, f.preview)}
      </Text>
    ));
  return (
    <Modal visible={s !== undefined} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel={t.close} />
      <View testID="assistant-sheet" style={styles.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled">
          {s?.kind === 'key' ? (
            <View>
              <Text style={styles.title}>{t.aiKeyTitle}</Text>
              <Text style={styles.body}>{t.aiKeyHelp}</Text>
              <TextInput
                testID="ai-key"
                accessibilityLabel={t.aiKeyTitle}
                style={styles.input}
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="sk-ant-…"
                placeholderTextColor={colors.muted}
              />
              <View style={styles.actions}>
                <Pressable
                  testID="ai-key-save"
                  accessibilityRole="button"
                  disabled={key.trim() === ''}
                  onPress={() => p.onKey(key)}
                  style={[styles.button, key.trim() === '' && styles.disabled]}
                >
                  <Text style={styles.buttonText}>{t.save}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {s?.kind === 'confirm' ? (
            <View>
              <Text testID="ai-confirm-title" style={styles.title}>
                {t.aiSendTitle(s.chars, s.what)}
              </Text>
              <Text style={styles.body}>{t.aiSendBody}</Text>
              {s.leaks.length > 0 ? (
                <View>
                  <Text testID="ai-leaks" style={styles.warning}>
                    {t.aiLeaksFound(s.leaks.length)}
                  </Text>
                  {leakList(s.leaks)}
                </View>
              ) : null}
              {s.warnings.length > 0 ? (
                <View>
                  <Text style={styles.warning}>{t.aiInjection}</Text>
                  {s.warnings.slice(0, 10).map((w) => (
                    <Text key={w} style={styles.leak}>
                      {w}
                    </Text>
                  ))}
                </View>
              ) : null}
              {preview ? (
                <Text testID="ai-preview" style={styles.code} selectable>
                  {s.text}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable testID="ai-send" accessibilityRole="button" onPress={p.onSend} style={styles.button}>
                  <Text style={styles.buttonText}>{s.leaks.length > 0 ? t.aiSendAnyway(s.send) : s.send}</Text>
                </Pressable>
                <Pressable
                  testID="ai-preview-toggle"
                  accessibilityRole="button"
                  onPress={() => setPreview((v) => !v)}
                  style={styles.secondary}
                >
                  <Text style={styles.link}>{preview ? t.aiHidePreview : t.aiPreview}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {s?.kind === 'busy' ? (
            <Text testID="ai-busy" style={styles.title}>
              {t.aiAsking(s.what)}
            </Text>
          ) : null}
          {s?.kind === 'answer' ? (
            <View>
              <Text style={styles.title}>{s.title}</Text>
              <Text style={styles.body}>{t.aiAnswerNote}</Text>
              <MarkdownView testID="ai-answer" markdown={s.markdown} />
              {s.canInsert ? (
                <Pressable testID="ai-insert" accessibilityRole="button" onPress={p.onInsert} style={styles.button}>
                  <Text style={styles.buttonText}>{t.aiInsertNote}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {s?.kind === 'leaks' ? (
            <View>
              <Text testID="leaks-title" style={styles.title}>
                {s.leaks.length === 0 ? t.noLeaks : t.aiLeaksFound(s.leaks.length)}
              </Text>
              {leakList(s.leaks)}
            </View>
          ) : null}
          <Pressable testID="assistant-close" accessibilityRole="button" onPress={close} style={styles.secondary}>
            <Text style={styles.link}>{s?.kind === 'busy' ? t.cancel : t.close}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    maxHeight: '85%',
    backgroundColor: c.background,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    paddingBottom: 28,
  },
  title: { fontSize: 17, color: c.text, marginBottom: 6 },
  body: { fontSize: 13, color: c.muted, lineHeight: 18, marginBottom: 8 },
  warning: { fontSize: 13, color: c.error, marginTop: 6 },
  leak: { fontFamily: mono, fontSize: 12, color: c.text, marginTop: 2 },
  code: { fontFamily: mono, fontSize: 12, color: c.text, backgroundColor: c.codeBackground, padding: 8, borderRadius: 6, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 15,
    color: c.text,
    marginVertical: 8,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 10 },
  button: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent, marginTop: 8 },
  buttonText: { fontSize: 15, color: c.onAccent },
  disabled: { opacity: 0.5 },
  secondary: { paddingVertical: 10, paddingHorizontal: 4 },
  link: { fontSize: 15, color: c.link },
}));

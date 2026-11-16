/**
 * New Runbook… (the start screen): a file name, blank or from a small template (a title and one
 * bash step), then the runbook opens in the editor (Edit as Text).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { newFileName, newRunbookText } from '../runbooks/editing';
import { addRunbook, useRunbooks } from '../runbooks/store';
import { themedStyles, usePalette } from '../theme';
import { Grabber } from './Grabber';
import { Points } from './Points';

export function NewRunbookSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {visible ? <Body onClose={onClose} /> : null}
    </Modal>
  );
}

function Body({ onClose }: { onClose(): void }) {
  const styles = useStyles();
  const colors = usePalette();
  const runbooks = useRunbooks();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(true);
  const file = newFileName(name, runbooks);
  const create = (): void => {
    if (!('name' in file)) return;
    const r = addRunbook(file.name, newRunbookText(file.name, template));
    onClose();
    router.push({ pathname: '/edit/[id]', params: { id: r.id } });
  };
  const chip = (on: boolean, testID: string, label: string, onPress: () => void) => (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      aria-checked={on}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.close} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View testID="new-runbook-sheet" style={styles.sheet}>
          <Grabber onClose={onClose} />
          <Text style={styles.title} role="heading">
            {t.newRunbookTitle}
          </Text>
          <Points items={t.newRunbookPoints} textStyle={styles.help} />
          <Text style={styles.label}>{t.newRunbookName}</Text>
          <TextInput
            testID="new-runbook-name"
            accessibilityLabel={t.newRunbookName}
            value={name}
            onChangeText={setName}
            placeholder={t.newRunbookNamePlaceholder}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={create}
            style={styles.input}
          />
          {name.trim() !== '' && 'problem' in file ? (
            <Text testID="new-runbook-problem" style={styles.error}>
              {file.problem}
            </Text>
          ) : null}
          <View accessibilityRole="radiogroup" style={styles.chips}>
            {chip(template, 'new-runbook-template', t.newRunbookTemplate, () => setTemplate(true))}
            {chip(!template, 'new-runbook-blank', t.newRunbookBlank, () => setTemplate(false))}
          </View>
          <View style={styles.buttons}>
            <Pressable testID="new-runbook-cancel" accessibilityRole="button" onPress={onClose} style={styles.secondary}>
              <Text style={styles.secondaryText}>{t.cancel}</Text>
            </Pressable>
            <Pressable
              testID="new-runbook-create"
              accessibilityRole="button"
              accessibilityState={{ disabled: !('name' in file) }}
              disabled={!('name' in file)}
              onPress={create}
              style={[styles.primary, !('name' in file) && styles.disabled]}
            >
              <Text style={styles.primaryText}>{t.newRunbookCreate}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: c.scrim },
  sheet: {
    backgroundColor: c.sheet,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    paddingBottom: 28,
  },
  title: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 6 },
  help: { fontSize: 13, color: c.muted, lineHeight: 18 },
  label: { fontSize: 13, color: c.muted, marginTop: 14, marginBottom: 4 },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: c.text,
    backgroundColor: c.background,
  },
  error: { fontSize: 13, color: c.error, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 20, backgroundColor: c.codeBackground },
  chipOn: { backgroundColor: c.accentSoft },
  chipText: { fontSize: 14, color: c.text },
  chipTextOn: { color: c.link, fontWeight: '600' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 16 },
  primary: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accent,
  },
  primaryText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  secondaryText: { fontSize: 15, color: c.link },
  disabled: { opacity: 0.5 },
}));

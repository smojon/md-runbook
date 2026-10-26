/**
 * Import hosts (hosts/share.ts): from a hosts link or QR code (`h`), or pasted text (a hosts.json
 * file or a link). Shows what would be added; hosts with a name the app already has are left
 * alone. The sender's host keys are trusted only when the user says so.
 */
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { readHosts, importHosts } from '../hosts/share';
import { useHosts } from '../hosts/store';
import { t } from '../i18n';
import { themedStyles, usePalette } from '../theme';
import { Toggle } from '../ui/Toggle';

export function HostsImport({ packed }: { packed: string | undefined }) {
  const styles = useStyles();
  const colors = usePalette();
  const existing = useHosts();
  const [text, setText] = useState(packed ?? '');
  const [trustKeys, setTrustKeys] = useState(false);
  const [done, setDone] = useState<{ added: string[]; skipped: string[] } | undefined>();
  const read = useMemo(() => (text.trim() ? readHosts(text) : undefined), [text]);
  const hosts = read && 'hosts' in read ? read.hosts : [];
  const have = new Set(existing.map((h) => h.name.toLowerCase()));
  const fresh = hosts.filter((h) => !have.has(h.name.toLowerCase()));
  const withKeys = fresh.some((h) => h.hostKey);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.help}>{t.hostsImportHelp}</Text>
      {packed === undefined ? (
        <TextInput
          testID="hosts-import-text"
          accessibilityLabel={t.hostsImportTitle}
          value={text}
          onChangeText={setText}
          placeholder={t.hostsImportPlaceholder}
          placeholderTextColor={colors.placeholder}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
      ) : null}
      {read && 'error' in read ? (
        <Text testID="hosts-import-error" role="alert" style={styles.error}>
          {read.error}
        </Text>
      ) : null}
      {hosts.length > 0 && !done ? (
        <View testID="hosts-import-list" style={styles.card}>
          {hosts.map((h) => (
            <Text key={h.name} style={have.has(h.name.toLowerCase()) ? styles.skip : styles.item}>
              {`${h.group ? `${h.group} · ` : ''}${h.name}: ${h.username}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`}`}
              {have.has(h.name.toLowerCase()) ? ` (${t.hostsAlreadyHave})` : ''}
            </Text>
          ))}
        </View>
      ) : null}
      {withKeys && !done ? (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.label}>{t.hostsTrustKeys}</Text>
            <Text style={styles.help}>{t.hostsTrustKeysHelp}</Text>
          </View>
          <Toggle testID="hosts-trust-keys" accessibilityLabel={t.hostsTrustKeys} value={trustKeys} onValueChange={setTrustKeys} />
        </View>
      ) : null}
      {done ? (
        <Text testID="hosts-import-done" style={styles.help}>
          {t.hostsImported(done.added.length, done.skipped.length)}
        </Text>
      ) : (
        <Pressable
          testID="hosts-import-go"
          accessibilityRole="button"
          disabled={fresh.length === 0}
          onPress={() => setDone(importHosts(hosts, trustKeys))}
          style={[styles.button, fresh.length === 0 && styles.disabled]}
        >
          <Text style={styles.buttonText}>{t.hostsImportGo(fresh.length)}</Text>
        </Pressable>
      )}
      {done ? (
        <Pressable testID="hosts-import-back" accessibilityRole="button" onPress={() => router.back()} style={styles.button}>
          <Text style={styles.buttonText}>{t.backToHosts}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, gap: 12 },
  help: { fontSize: 13, color: c.muted, lineHeight: 18 },
  label: { fontSize: 15, color: c.text },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    color: c.text,
    backgroundColor: c.surface,
    textAlignVertical: 'top',
  },
  error: { fontSize: 13, color: c.error },
  card: { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12, gap: 6, backgroundColor: c.surface },
  item: { fontSize: 14, color: c.text },
  skip: { fontSize: 14, color: c.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accent,
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  disabled: { opacity: 0.5 },
}));

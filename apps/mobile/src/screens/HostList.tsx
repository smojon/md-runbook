import * as Clipboard from 'expo-clipboard';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { VAR_NAME_RE } from '@md-runbook/core/secrets';
import { Host, hostLabel, useHosts } from '../hosts/store';
import { t } from '../i18n';
import { KeyStorage, appKeyInfo, appPublicKeyLine } from '../ssh/appKey';
import { forgetSecret, loadSecretNames, storeSecret, useSecretNames } from '../secrets/store';
import { HISTORY_SIZES, setHistorySize, useHistorySize } from '../settings/store';
import { getRelaySettings, setRelaySettings } from '../ssh/relaySettings';
import { mono, themedStyles } from '../theme';

/** The hosts, the app's public key to put on them and, on the web, the relay settings. */
export function HostList() {
  const styles = useStyles();
  const hosts = useHosts();
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      data={hosts}
      keyExtractor={(h) => h.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <Link href={{ pathname: '/hosts/[id]', params: { id: 'new' } }} asChild>
            <Pressable testID="add-host" accessibilityRole="button" style={styles.button}>
              <Text style={styles.buttonText}>{t.addHost}</Text>
            </Pressable>
          </Link>
          {hosts.length === 0 ? <Text style={styles.help}>{t.noHosts}</Text> : null}
        </View>
      }
      renderItem={({ item }) => <HostRow host={item} />}
      ListFooterComponent={
        <>
          <AppKeySection />
          <SecretsSection />
          <HistorySection />
          {Platform.OS === 'web' ? <RelaySection /> : null}
        </>
      }
    />
  );
}

function HostRow({ host }: { host: Host }) {
  const styles = useStyles();
  return (
    <Link href={{ pathname: '/hosts/[id]', params: { id: host.id } }} asChild>
      <Pressable testID={`host-${host.id}`} accessibilityRole="link" aria-label={host.name} style={styles.row}>
        <Text style={styles.title}>{host.name}</Text>
        <Text style={styles.meta}>
          {hostLabel(host)}
          {' · '}
          {host.hostKey ? t.hostKeyTrusted : t.hostKeyNotTrusted}
          {host.platform ? ` · ${t.hostPlatform[host.platform]}` : ''}
        </Text>
      </Pressable>
    </Link>
  );
}

function AppKeySection() {
  const styles = useStyles();
  const [line, setLine] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [storage, setStorage] = useState<KeyStorage | undefined>();
  useEffect(() => {
    let live = true;
    appPublicKeyLine().then(
      (l) => live && setLine(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    appKeyInfo().then(
      (k) => live && setStorage(k.storage),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const copy = async (): Promise<void> => {
    if (!line) return;
    await Clipboard.setStringAsync(line);
    setCopied(true);
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.appKeyTitle}</Text>
      <Text style={styles.help}>{t.appKeyHelp}</Text>
      {error ? (
        <Text testID="app-key-error" role="alert" style={styles.error}>
          {t.appKeyFailed(error)}
        </Text>
      ) : (
        <Text testID="app-public-key" style={styles.key} selectable>
          {line ?? t.appKeyLoading}
        </Text>
      )}
      {storage ? (
        <Text testID="app-key-storage" style={styles.help}>
          {t.appKeyStorage[storage]}
        </Text>
      ) : null}
      <Pressable
        testID="copy-public-key"
        accessibilityRole="button"
        disabled={!line}
        onPress={() => void copy()}
        style={[styles.button, !line && styles.disabled]}
      >
        <Text style={styles.buttonText}>{copied ? t.copied : t.copy}</Text>
      </Pressable>
    </View>
  );
}

/** The stored `${secret:NAME}` names (never their values), each with Forget. */
/** How many earlier runs each cell keeps in the file (the extension's mdRunbook.output.historySize). */
function HistorySection() {
  const styles = useStyles();
  const size = useHistorySize();
  return (
    <View testID="history-setting" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.historyTitle}</Text>
      <Text style={styles.help}>{t.historyHelp}</Text>
      <View style={styles.chips}>
        {HISTORY_SIZES.map((n) => (
          <Pressable
            key={n}
            testID={`history-${n}`}
            accessibilityRole="button"
            accessibilityState={{ selected: n === size }}
            onPress={() => setHistorySize(n)}
            style={[styles.chip, n === size && styles.chipOn]}
          >
            <Text style={[styles.chipText, n === size && styles.chipTextOn]}>{t.historyKeep(n)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function SecretsSection() {
  const styles = useStyles();
  const names = useSecretNames();
  /** The secret whose new value is being typed, and that value. */
  const [editing, setEditing] = useState<{ name: string; value: string } | undefined>();
  useEffect(() => {
    void loadSecretNames();
  }, []);
  const save = async (): Promise<void> => {
    if (!editing || editing.value === '') return;
    await storeSecret(editing.name, editing.value);
    setEditing(undefined);
  };
  /** A new secret being typed (before any cell asks for it). */
  const [adding, setAdding] = useState<{ name: string; value: string } | undefined>();
  const addable = adding !== undefined && VAR_NAME_RE.test(adding.name) && adding.value !== '';
  const add = async (): Promise<void> => {
    if (!adding || !addable) return;
    await storeSecret(adding.name, adding.value);
    setAdding(undefined);
  };
  return (
    <View testID="secrets" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.secretsTitle}</Text>
      <Text style={styles.help}>{names.length > 0 ? t.secretsHelp : t.secretsNone}</Text>
      {names.map((n) => (
        <View key={n}>
          <View style={styles.secretRow}>
            <Text style={styles.secretName}>{n}</Text>
            <View style={styles.secretActions}>
              <Pressable testID={`change-secret-${n}`} accessibilityRole="button" onPress={() => setEditing({ name: n, value: '' })}>
                <Text style={styles.link}>{t.changeSecret}</Text>
              </Pressable>
              <Pressable testID={`forget-secret-${n}`} accessibilityRole="button" onPress={() => void forgetSecret(n)}>
                <Text style={styles.link}>{t.forgetSecret}</Text>
              </Pressable>
            </View>
          </View>
          {editing?.name === n ? (
            <View style={styles.secretEdit}>
              <TextInput
                testID={`secret-value-${n}`}
                accessibilityLabel={t.newSecretValue(n)}
                style={[styles.input, styles.secretInput]}
                value={editing.value}
                onChangeText={(value) => setEditing({ name: n, value })}
                placeholder={t.newSecretValue(n)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                testID={`save-secret-${n}`}
                accessibilityRole="button"
                disabled={editing.value === ''}
                onPress={() => void save()}
                style={[styles.button, editing.value === '' && styles.disabled]}
              >
                <Text style={styles.buttonText}>{t.save}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
      {adding ? (
        <View testID="add-secret-form">
          <Text style={styles.label}>{t.secretName}</Text>
          <TextInput
            testID="new-secret-name"
            accessibilityLabel={t.secretName}
            style={styles.input}
            value={adding.name}
            onChangeText={(name) => setAdding({ ...adding, name })}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {adding.name !== '' && !VAR_NAME_RE.test(adding.name) ? <Text style={styles.error}>{t.badSecretName}</Text> : null}
          <Text style={styles.label}>{t.secretValue}</Text>
          <TextInput
            testID="new-secret-value"
            accessibilityLabel={t.secretValue}
            style={styles.input}
            value={adding.value}
            onChangeText={(value) => setAdding({ ...adding, value })}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            testID="save-new-secret"
            accessibilityRole="button"
            disabled={!addable}
            onPress={() => void add()}
            style={[styles.button, !addable && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.save}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable testID="add-secret" accessibilityRole="button" onPress={() => setAdding({ name: '', value: '' })} style={styles.button}>
          <Text style={styles.buttonText}>{t.addSecret}</Text>
        </Pressable>
      )}
    </View>
  );
}

function RelaySection() {
  const styles = useStyles();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    void getRelaySettings().then((s) => {
      if (live && s) {
        setUrl(s.url);
        setToken(s.token);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const save = async (): Promise<void> => {
    await setRelaySettings({ url, token });
    setSaved(true);
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.relayTitle}</Text>
      <Text style={styles.help}>{t.relayHelp}</Text>
      <Text style={styles.label}>{t.relayUrl}</Text>
      <TextInput
        testID="relay-url"
        style={styles.input}
        value={url}
        onChangeText={(v) => {
          setUrl(v);
          setSaved(false);
        }}
        placeholder={t.relayUrlPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.label}>{t.relayToken}</Text>
      <TextInput
        testID="relay-token"
        style={styles.input}
        value={token}
        onChangeText={(v) => {
          setToken(v);
          setSaved(false);
        }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable testID="relay-save" accessibilityRole="button" onPress={() => void save()} style={styles.button}>
        <Text style={styles.buttonText}>{saved ? t.relaySaved : t.save}</Text>
      </Pressable>
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  header: { paddingVertical: 12 },
  button: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: colors.accent,
    marginTop: 8,
  },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 15, color: colors.onAccent },
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 17, color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  section: { marginTop: 28 },
  sectionTitle: { fontSize: 17, color: colors.text, marginBottom: 6 },
  help: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 4 },
  key: {
    fontFamily: mono,
    fontSize: 12,
    color: colors.text,
    backgroundColor: colors.codeBackground,
    borderRadius: 6,
    padding: 10,
    marginTop: 8,
  },
  label: { fontSize: 13, color: colors.muted, marginTop: 12 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    fontSize: 15,
    color: colors.text,
    marginTop: 4,
  },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: colors.onAccent },
  secretRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  secretName: { fontFamily: mono, fontSize: 14, color: colors.text },
  secretActions: { flexDirection: 'row', gap: 16 },
  secretEdit: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  secretInput: { flex: 1, marginTop: 0 },
  link: { fontSize: 15, color: colors.link },
}));

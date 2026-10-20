import * as Clipboard from 'expo-clipboard';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Host, hostLabel, useHosts } from '../hosts/store';
import { t } from '../i18n';
import { appPublicKeyLine } from '../ssh/appKey';
import { getRelaySettings, setRelaySettings } from '../ssh/relaySettings';
import { colors, mono } from '../theme';

/** The hosts, the app's public key to put on them and, on the web, the relay settings. */
export function HostList() {
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
          {Platform.OS === 'web' ? <RelaySection /> : null}
        </>
      }
    />
  );
}

function HostRow({ host }: { host: Host }) {
  return (
    <Link href={{ pathname: '/hosts/[id]', params: { id: host.id } }} asChild>
      <Pressable testID={`host-${host.id}`} accessibilityRole="link" aria-label={host.name} style={styles.row}>
        <Text style={styles.title}>{host.name}</Text>
        <Text style={styles.meta}>
          {hostLabel(host)}
          {' · '}
          {host.hostKey ? t.hostKeyTrusted : t.hostKeyNotTrusted}
        </Text>
      </Pressable>
    </Link>
  );
}

function AppKeySection() {
  const [line, setLine] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    appPublicKeyLine().then(
      (l) => live && setLine(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
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

function RelaySection() {
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

const styles = StyleSheet.create({
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
});

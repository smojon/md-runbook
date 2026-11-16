/**
 * Hosts & settings → Publishing to the library: the library server Publish to Library… and Remove
 * from Library… send to (by default the origin of the team library the app reads), and its upload
 * token: set, replaced or forgotten. The token is kept in the app's secure storage (on the web,
 * this browser's storage, as the screen says).
 */
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { useLibrary } from '../runbooks/library';
import {
  TOKEN_RE,
  defaultLibraryServer,
  forgetToken,
  libraryServer,
  libraryServerAddress,
  serverHost,
  storeToken,
  storedToken,
} from '../runbooks/libraryPublish';
import { setLibraryServer, useLibraryServerSetting, useLibraryUrlSetting } from '../settings/store';
import { useRuntimeConfig } from '../settings/runtimeConfig';
import { themedStyles, usePalette } from '../theme';
import { Points } from '../ui/Points';

export function LibraryPublishSettings() {
  const styles = useStyles();
  const colors = usePalette();
  const saved = useLibraryServerSetting();
  // The default follows the library's address (and, on the web, the container's).
  useLibraryUrlSetting();
  useRuntimeConfig();
  useLibrary();
  const [draft, setDraft] = useState(saved);
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setDraft(saved);
  }
  const typed = draft.trim();
  const address = typed === '' ? undefined : libraryServerAddress(typed);
  const problem = address && 'problem' in address ? address.problem : undefined;
  const server = libraryServer();
  const [hasToken, setHasToken] = useState<boolean | undefined>();
  const [token, setToken] = useState<string | undefined>();
  const [said, setSaid] = useState<string | undefined>();
  useEffect(() => {
    if (!server) return;
    let live = true;
    void storedToken(server).then((v) => {
      if (live) setHasToken(!!v);
    });
    return () => {
      live = false;
    };
  }, [server]);
  const tokenOk = token !== undefined && TOKEN_RE.test(token.trim());
  return (
    <View testID="publish-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.publishSettingsTitle}</Text>
      <Points items={t.publishSettingsPoints} textStyle={styles.help} />
      <Text style={styles.label}>{t.publishServer}</Text>
      <TextInput
        testID="publish-server"
        accessibilityLabel={t.publishServer}
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder={defaultLibraryServer() ?? 'https://runbooks.example.net'}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {problem ? (
        <Text testID="publish-server-problem" style={styles.error}>
          {problem}
        </Text>
      ) : null}
      <Text testID="publish-server-now" style={styles.help}>
        {server ? t.publishServerNow(server) : t.publishServerNone}
      </Text>
      <View style={styles.chips}>
        {typed !== saved ? (
          <Pressable
            testID="publish-server-save"
            accessibilityRole="button"
            disabled={problem !== undefined}
            onPress={() => setLibraryServer(address && 'base' in address ? address.base : '')}
            style={[styles.button, problem !== undefined && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.publishServerSave}</Text>
          </Pressable>
        ) : null}
        {saved ? (
          <Pressable testID="publish-server-remove" accessibilityRole="button" onPress={() => setLibraryServer('')} style={styles.button}>
            <Text style={styles.buttonText}>{t.publishServerRemove}</Text>
          </Pressable>
        ) : null}
      </View>
      {server ? (
        <View testID="publish-token-settings">
          <Text testID="publish-token-state" style={styles.label}>
            {hasToken ? t.publishTokenStored(serverHost(server)) : t.publishTokenNone(serverHost(server))}
          </Text>
          {token !== undefined ? (
            <>
              <TextInput
                testID="publish-token-input"
                accessibilityLabel={t.publishToken(serverHost(server))}
                style={styles.input}
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              {token.trim() !== '' && !tokenOk ? <Text style={styles.error}>{t.publishTokenShape}</Text> : null}
            </>
          ) : null}
          <Points items={[t.publishTokenFrom, Platform.OS === 'web' ? t.tokenKeptWeb : t.tokenKeptDevice]} textStyle={styles.help} />
          <View style={styles.chips}>
            {token === undefined ? (
              <Pressable
                testID="publish-token-set"
                accessibilityRole="button"
                onPress={() => {
                  setSaid(undefined);
                  setToken('');
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>{hasToken ? t.publishTokenReplace : t.publishTokenSet}</Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  testID="publish-token-save"
                  accessibilityRole="button"
                  disabled={!tokenOk}
                  onPress={() =>
                    void storeToken(server, token).then(() => {
                      setToken(undefined);
                      setHasToken(true);
                      setSaid(t.publishTokenSaved);
                    })
                  }
                  style={[styles.button, !tokenOk && styles.disabled]}
                >
                  <Text style={styles.buttonText}>{t.publishServerSave}</Text>
                </Pressable>
                <Pressable
                  testID="publish-token-cancel"
                  accessibilityRole="button"
                  onPress={() => setToken(undefined)}
                  style={styles.plain}
                >
                  <Text style={styles.link}>{t.cancel}</Text>
                </Pressable>
              </>
            )}
            {hasToken && token === undefined ? (
              <Pressable
                testID="publish-token-forget"
                accessibilityRole="button"
                onPress={() =>
                  void forgetToken(server).then(() => {
                    setHasToken(false);
                    setSaid(t.publishTokenForgotten);
                  })
                }
                style={styles.button}
              >
                <Text style={styles.buttonText}>{t.publishTokenForget}</Text>
              </Pressable>
            ) : null}
          </View>
          {said ? (
            <Text testID="publish-token-said" role="status" style={styles.ok}>
              {said}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  // As the team library's section (LibrarySettings.tsx).
  section: {
    marginTop: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  help: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 4 },
  label: { fontSize: 13, color: colors.muted, marginTop: 12 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.background,
    padding: 10,
    fontSize: 15,
    color: colors.text,
    marginTop: 4,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  plain: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 15, color: colors.link },
  disabled: { opacity: 0.5 },
  ok: { fontSize: 13, color: colors.ok, marginTop: 8 },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
}));

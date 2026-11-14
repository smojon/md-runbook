/**
 * mdrunbook://library?url=… and the web app's /library?url=… (Share library's QR code, a link in
 * a mail): asks before adding the team library at that address. Adding it only lists its
 * runbooks; nothing runs and no signer is trusted.
 */
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { t } from '../i18n';
import { libraryBase, libraryHost, libraryUrlProblem, normalizeLibraryUrl, refreshLibrary } from '../runbooks/library';
import { setLibraryUrl, useLibraryUrlSetting } from '../settings/store';
import { themedStyles } from '../theme';

export function LibraryAdd({ url }: { url: string | undefined }) {
  const styles = useStyles();
  // Read so the screen updates once the settings are in (a cold start from the link).
  useLibraryUrlSetting();
  const problem = url === undefined || url.trim() === '' ? t.libraryAddLinkInvalid : libraryUrlProblem(url);
  const home = (): void => (router.canGoBack() ? router.back() : router.replace('/'));
  if (problem || url === undefined) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text testID="library-add-error" role="alert" style={styles.error}>
          {problem}
        </Text>
        <Pressable accessibilityRole="button" onPress={home} style={styles.secondary}>
          <Text style={styles.secondaryText}>{t.backToRunbooks}</Text>
        </Pressable>
      </ScrollView>
    );
  }
  // The parsed address, as it will be stored and fetched: the host and address shown are the ones used.
  const base = normalizeLibraryUrl(url);
  const host = libraryHost(base);
  const current = libraryBase();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text testID="library-add-prompt" style={styles.title} role="heading">
        {t.libraryAddPrompt(host)}
      </Text>
      <Text style={styles.body}>{t.libraryAddBody(base)}</Text>
      {current && current !== base ? <Text style={[styles.body, styles.warn]}>{t.libraryAddReplaces(current)}</Text> : null}
      <View style={styles.buttons}>
        <Pressable
          testID="library-add-go"
          accessibilityRole="button"
          onPress={() => {
            setLibraryUrl(base);
            void refreshLibrary({ force: true });
            router.replace('/');
          }}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{t.libraryAddGo}</Text>
        </Pressable>
        <Pressable testID="library-add-cancel" accessibilityRole="button" onPress={home} style={styles.secondary}>
          <Text style={styles.secondaryText}>{t.cancel}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 18, fontWeight: '600', color: c.text },
  body: { fontSize: 15, color: c.text, lineHeight: 21 },
  warn: { color: c.warningText },
  error: { fontSize: 15, color: c.error },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  primary: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, backgroundColor: c.accent },
  primaryText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  secondary: { paddingVertical: 10, paddingHorizontal: 8 },
  secondaryText: { fontSize: 15, color: c.link },
}));

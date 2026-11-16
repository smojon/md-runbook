/**
 * Hosts & settings → Alerts on this phone: firing alerts of the team library's server as
 * notifications (notifications/alertPush.ts). A switch, and the devices token it registers with.
 * A build without push set up (no Firebase file, no APNs entitlement) says so and does nothing;
 * the web has no pushes and shows nothing.
 */
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { libraryBase, useLibrary } from '../runbooks/library';
import { useLibraryUrlSetting } from '../settings/store';
import { themedStyles, usePalette } from '../theme';
import { Points } from '../ui/Points';
import { Toggle } from '../ui/Toggle';
import {
  alertPushSupport,
  loadAlertPush,
  serverOf,
  turnOffAlertPush,
  turnOnAlertPush,
  useAlertRegistration,
} from '../notifications/alertPush';

export function AlertPushSettings({ fetcher }: { fetcher?: typeof fetch }) {
  const styles = useStyles();
  const colors = usePalette();
  const support = alertPushSupport();
  const reg = useAlertRegistration();
  // The library's address decides the server; re-rendered when it changes.
  useLibraryUrlSetting();
  useLibrary();
  const server = serverOf(libraryBase());
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean; blocked?: boolean } | undefined>();
  useEffect(() => {
    void loadAlertPush();
  }, []);
  if (support === 'web') return null;
  const on = reg !== undefined;
  const usable = support === 'ok' && server !== undefined;
  const flip = async (want: boolean): Promise<void> => {
    if (!usable && want) return;
    setBusy(true);
    setNote(undefined);
    const r = want ? await turnOnAlertPush(libraryBase(), token, fetcher) : await turnOffAlertPush(fetcher);
    setBusy(false);
    if (r.ok) setToken('');
    else setNote({ text: r.message, error: true, ...(r.blocked ? { blocked: true } : {}) });
  };
  return (
    <View testID="alert-push-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.alertPushTitle}</Text>
      <Points items={t.alertPushPoints} textStyle={styles.help} />
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t.alertPushSwitch}</Text>
        <Toggle
          testID="alert-push-switch"
          accessibilityLabel={t.alertPushSwitch}
          value={on}
          onValueChange={(want) => {
            if (!busy) void flip(want);
          }}
        />
      </View>
      {support !== 'ok' ? (
        <Text testID="alert-push-unavailable" style={styles.help}>
          {t.alertPushNotInBuild}
        </Text>
      ) : !server && !on ? (
        <Text testID="alert-push-no-library" style={styles.help}>
          {t.alertPushNoLibrary}
        </Text>
      ) : null}
      {usable && !on ? (
        <>
          <Text style={styles.label}>{t.alertPushToken}</Text>
          <TextInput
            testID="alert-push-token"
            accessibilityLabel={t.alertPushToken}
            style={styles.input}
            value={token}
            onChangeText={(v) => {
              setToken(v);
              setNote(undefined);
            }}
            placeholder={t.alertPushTokenPlaceholder}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Text style={styles.help}>{t.alertPushTokenHelp}</Text>
        </>
      ) : null}
      {busy ? <Text style={styles.help}>{t.alertPushWorking}</Text> : null}
      {on && !busy ? (
        <Text testID="alert-push-on" style={styles.ok}>
          {t.alertPushOn(new URL(reg.server).host)}
        </Text>
      ) : null}
      {note ? (
        <Text testID="alert-push-note" role="alert" style={note.error ? styles.error : styles.help}>
          {note.text}
        </Text>
      ) : null}
      {note?.blocked ? (
        <Pressable testID="alert-push-open-settings" accessibilityRole="button" onPress={() => void Linking.openSettings()}>
          <Text style={styles.link}>{t.openSettings}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// As LibrarySettings' card.
const useStyles = themedStyles((colors) => ({
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
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 },
  switchLabel: { fontSize: 15, color: colors.text, flexShrink: 1 },
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
  ok: { fontSize: 13, color: colors.ok, marginTop: 8 },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  link: { fontSize: 15, color: colors.link, marginTop: 8 },
}));

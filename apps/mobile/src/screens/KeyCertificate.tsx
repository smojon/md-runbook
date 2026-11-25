/**
 * Hosts & settings → This app's SSH key → Certificate: attach the OpenSSH certificate the
 * company CA issued for this key (paste or file), see its key ID, users and expiry, remove it.
 * The start screen shows CertificateNotice when it expires soon or has expired.
 */
import { CertKeyPair, type SshCertificate } from '@md-runbook/ssh';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { appKeyInfo, type KeyStorage } from '../ssh/appKey';
import {
  CertificateError,
  appCertState,
  attachAppCert,
  loadAppCert,
  localDateTime,
  removeAppCert,
  timeLeft,
  useAppCert,
} from '../ssh/appCert';
import { pickCertificateFile } from '../ssh/certFile';
import { mono, themedStyles, usePalette } from '../theme';
import { confirmThen } from '../ui/confirm';
import { Points } from '../ui/Points';

const left = (seconds: number, now = Date.now()): string => {
  const { n, unit } = timeLeft(seconds, now);
  return t.inTime(n, unit);
};

/** The warning for the certificate's state, or undefined while it is valid. */
export function certWarning(cert: SshCertificate, now = Date.now()): string | undefined {
  const state = appCertState(cert, now);
  if (state === 'expired') return t.certExpired(localDateTime(cert.validBefore));
  if (state === 'expiring') return t.certExpiring(left(cert.validBefore, now));
  if (state === 'not-yet') return t.certNotYet(localDateTime(cert.validAfter));
  return undefined;
}

export function KeyCertificateSection({ storage }: { storage: KeyStorage | undefined }) {
  const styles = useStyles();
  const colors = usePalette();
  const cert = useAppCert();
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  /** A stored certificate found not to be for the key in use (it changed elsewhere). */
  const [mismatched, setMismatched] = useState<SshCertificate | undefined>();
  const otherKey = cert !== undefined && mismatched === cert;
  useEffect(() => void loadAppCert(), []);
  useEffect(() => {
    let live = true;
    if (!cert) return;
    appKeyInfo()
      .then((k) => CertKeyPair.create(k.pair, cert))
      .then(
        () => live && setMismatched(undefined),
        () => live && setMismatched(cert),
      );
    return () => {
      live = false;
    };
  }, [cert, storage]);

  if (storage === 'passkey') {
    return (
      <View testID="key-cert" style={styles.block}>
        <Text style={styles.label}>{t.certTitle}</Text>
        <Points items={t.certPasskeyPoints} textStyle={styles.help} />
      </View>
    );
  }

  const attach = async (text: string): Promise<void> => {
    try {
      await attachAppCert(text, await appKeyInfo());
      setPasting(false);
      setDraft('');
      setMessage({ ok: true, text: t.certAttached });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const reason = e instanceof CertificateError ? e.reason : 'unreadable';
      setMessage({
        ok: false,
        text: reason === 'other-key' ? t.certOtherKey : reason === 'passkey' ? t.certPasskeyPoints[0]! : t.certUnreadable(why),
      });
    }
  };
  const fromFile = async (): Promise<void> => {
    setMessage(undefined);
    try {
      const picked = await pickCertificateFile();
      if (picked.kind === 'too-large') setMessage({ ok: false, text: t.certFileTooLarge });
      else if (picked.kind === 'picked') await attach(picked.text);
    } catch (e) {
      setMessage({ ok: false, text: t.certUnreadable(e instanceof Error ? e.message : String(e)) });
    }
  };
  const remove = (): void =>
    confirmThen(t.certRemoveTitle, t.certRemovePoints, t.certRemove, () => {
      setMessage(undefined);
      void removeAppCert();
    });
  const warning = cert ? (otherKey ? t.certOtherKey : certWarning(cert)) : undefined;

  return (
    <View testID="key-cert" style={styles.block}>
      <Text style={styles.label}>{t.certTitle}</Text>
      {cert ? (
        <View testID="key-cert-details">
          <Text style={styles.body} selectable>
            {t.certKeyId(cert.keyId)}
          </Text>
          <Text style={styles.body}>{t.certPrincipals(cert.principals)}</Text>
          <Text testID="key-cert-validity" style={styles.body}>
            {cert.validBefore === Infinity ? t.certValidForever : t.certValidUntil(localDateTime(cert.validBefore), left(cert.validBefore))}
          </Text>
          <Text style={styles.mono} selectable>
            {t.certCa(cert.caFingerprint)}
          </Text>
          {warning ? (
            <Text testID="key-cert-warning" role="alert" style={[styles.help, { color: colors.warningText }]}>
              {warning}
            </Text>
          ) : null}
        </View>
      ) : (
        <Points items={t.certNonePoints} textStyle={styles.help} />
      )}
      {pasting ? (
        <>
          <Text style={styles.help}>{t.certPasteLabel}</Text>
          <TextInput
            testID="key-cert-input"
            accessibilityLabel={t.certPasteLabel}
            style={[styles.input, styles.monoInput]}
            value={draft}
            onChangeText={(v) => {
              setDraft(v);
              setMessage(undefined);
            }}
            placeholder={t.certPastePlaceholder}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <View style={styles.chips}>
            <Pressable
              testID="key-cert-attach"
              accessibilityRole="button"
              disabled={draft.trim() === ''}
              onPress={() => void attach(draft)}
              style={[styles.button, draft.trim() === '' && styles.disabled]}
            >
              <Text style={styles.buttonText}>{t.certAttach}</Text>
            </Pressable>
            <Pressable testID="key-cert-cancel" accessibilityRole="button" onPress={() => setPasting(false)} style={styles.button}>
              <Text style={styles.buttonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={styles.chips}>
          <Pressable
            testID="key-cert-paste"
            accessibilityRole="button"
            onPress={() => {
              setMessage(undefined);
              setPasting(true);
            }}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t.certPaste}</Text>
          </Pressable>
          <Pressable testID="key-cert-file" accessibilityRole="button" onPress={() => void fromFile()} style={styles.button}>
            <Text style={styles.buttonText}>{t.certFromFile}</Text>
          </Pressable>
          {cert ? (
            <Pressable testID="key-cert-remove" accessibilityRole="button" onPress={remove} style={styles.button}>
              <Text style={styles.buttonText}>{t.certRemove}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {message ? (
        <Text testID="key-cert-message" role={message.ok ? undefined : 'alert'} style={message.ok ? styles.ok : styles.error}>
          {message.text}
        </Text>
      ) : null}
    </View>
  );
}

/** Start screen: the certificate expires soon or has expired. A tap opens Hosts & settings. */
export function CertificateNotice() {
  const styles = useStyles();
  const colors = usePalette();
  const cert = useAppCert();
  useEffect(() => void loadAppCert(), []);
  if (!cert) return null;
  const state = appCertState(cert);
  if (state !== 'expiring' && state !== 'expired') return null;
  const text = state === 'expired' ? t.certHomeExpired : t.certHomeExpiring(left(cert.validBefore));
  return (
    <Pressable
      testID="cert-notice"
      accessibilityRole="link"
      onPress={() => router.push('/hosts')}
      style={[styles.notice, { borderLeftColor: colors.warning }]}
    >
      <Text role="alert" style={styles.body}>
        {text}
      </Text>
    </Pressable>
  );
}

const useStyles = themedStyles((colors) => ({
  block: { marginTop: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  label: { fontSize: 15, fontWeight: '600', color: colors.text },
  body: { fontSize: 14, color: colors.text, lineHeight: 20, marginTop: 2 },
  help: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 4 },
  mono: { fontSize: 12, color: colors.muted, fontFamily: mono, marginTop: 2 },
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
  monoInput: { fontFamily: mono, fontSize: 13, minHeight: 64 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // As the other settings' buttons (HostList.tsx).
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.accent,
    marginTop: 8,
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  disabled: { opacity: 0.5 },
  ok: { fontSize: 13, color: colors.ok, marginTop: 8 },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  notice: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderLeftWidth: 4,
    backgroundColor: colors.surface,
  },
}));

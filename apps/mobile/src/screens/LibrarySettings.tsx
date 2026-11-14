/**
 * Hosts & settings → Team library: the library's address (on the phones there is none until one
 * is set; on the web the app's own /runbooks/ by default), a check that reads it, Remove, and
 * Share library as a QR code (mdrunbook://library?url=…); the trusted signers, with Remove.
 */
import { qrMatrix } from '@md-runbook/core/qr';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { t } from '../i18n';
import {
  defaultLibraryBase,
  fetchLibrary,
  libraryBase,
  libraryHost,
  libraryLink,
  libraryUrlProblem,
  normalizeLibraryUrl,
  refreshLibrary,
  useLibrary,
  withdrawnKeys,
} from '../runbooks/library';
import { setLibraryUrl, useLibraryUrlSetting } from '../settings/store';
import { removeTrustedSigner, sameSigner, shownPrincipal, useTrustedSigners } from '../signing/trust';
import { mono, themedStyles, usePalette } from '../theme';
import { QrView } from '../ui/QrView';

export function LibrarySettings({ fetcher }: { fetcher?: typeof fetch }) {
  const styles = useStyles();
  const colors = usePalette();
  const { width } = useWindowDimensions();
  const saved = useLibraryUrlSetting();
  const [draft, setDraft] = useState(saved);
  // The address saved elsewhere (a library link, a cold start's settings): the field shows it.
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setDraft(saved);
  }
  const [check, setCheck] = useState<{ ok: boolean; text: string } | undefined>();
  const [checking, setChecking] = useState(false);
  const [qr, setQr] = useState(false);
  const fallback = defaultLibraryBase();
  const problem = draft.trim() === '' ? undefined : libraryUrlProblem(draft);
  /** The address the check reads: what is typed, else the default. */
  const target = draft.trim() === '' ? fallback : problem ? undefined : normalizeLibraryUrl(draft);
  const effective = libraryBase();
  const runCheck = async (): Promise<void> => {
    if (!target) return;
    setChecking(true);
    setCheck(undefined);
    const r = await fetchLibrary(target, fetcher);
    setChecking(false);
    setCheck(
      r.kind === 'ok'
        ? { ok: true, text: t.libraryChecked(r.library.entries.length) }
        : r.kind === 'none'
          ? { ok: false, text: t.libraryNone }
          : { ok: false, text: t.libraryFailed(r.message) },
    );
  };
  const save = (url: string): void => {
    setLibraryUrl(url);
    setCheck(undefined);
    void refreshLibrary({ force: true });
  };
  const matrix = qr && effective ? qrMatrix(libraryLink(effective)) : undefined;
  return (
    <View testID="library-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.libraryTitle}</Text>
      <Text style={styles.help}>{t.libraryHelp}</Text>
      {fallback ? <Text style={styles.help}>{t.libraryHelpWeb(fallback)}</Text> : null}
      <Text style={styles.label}>{t.libraryUrl}</Text>
      <TextInput
        testID="library-url"
        accessibilityLabel={t.libraryUrl}
        style={styles.input}
        value={draft}
        onChangeText={(v) => {
          setDraft(v);
          setCheck(undefined);
        }}
        placeholder={fallback ?? t.libraryUrlPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {problem ? (
        <Text testID="library-url-problem" style={styles.error}>
          {problem}
        </Text>
      ) : null}
      <View style={styles.chips}>
        <Pressable
          testID="library-check"
          accessibilityRole="button"
          disabled={!target || checking}
          onPress={() => void runCheck()}
          style={[styles.button, (!target || checking) && styles.disabled]}
        >
          <Text style={styles.buttonText}>{t.libraryCheck}</Text>
        </Pressable>
        {draft.trim() !== saved ? (
          <Pressable
            testID="library-save"
            accessibilityRole="button"
            disabled={problem !== undefined}
            onPress={() => save(draft.trim() === '' ? '' : normalizeLibraryUrl(draft))}
            style={[styles.button, problem !== undefined && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.librarySave}</Text>
          </Pressable>
        ) : null}
        {saved ? (
          <Pressable testID="library-remove" accessibilityRole="button" onPress={() => save('')} style={styles.button}>
            <Text style={styles.buttonText}>{t.libraryRemove}</Text>
          </Pressable>
        ) : null}
        {effective ? (
          <Pressable testID="library-share" accessibilityRole="button" aria-expanded={qr} onPress={() => setQr(!qr)} style={styles.button}>
            <Text style={styles.buttonText}>{t.libraryShare}</Text>
          </Pressable>
        ) : null}
      </View>
      {checking ? <Text style={styles.help}>{t.libraryLoading}</Text> : null}
      {check ? (
        <Text testID="library-check-result" style={check.ok ? styles.ok : styles.error}>
          {check.text}
        </Text>
      ) : null}
      {matrix ? (
        <View style={styles.qrBox}>
          <QrView testID="library-share-code" matrix={matrix} size={Math.min(width - 96, 300)} />
          <Text style={styles.help}>{t.libraryShareHelp}</Text>
        </View>
      ) : null}
      <TrustedSignersList />
    </View>
  );
}

/** Hosts & settings → Team library → Trusted signers: every key trusted, the library it counts for, Remove. */
function TrustedSignersList() {
  const styles = useStyles();
  const signers = useTrustedSigners();
  const lib = useLibrary();
  // The library read now: keys trusted from it that its allowed_signers no longer lists are flagged.
  const withdrawn = lib.library ? withdrawnKeys(lib.library) : [];
  return (
    <View testID="trusted-signers">
      <Text style={styles.label}>{t.trustedSignersTitle}</Text>
      <Text style={styles.help}>{signers.length > 0 ? t.trustedSignersHelp : t.trustedSignersNone}</Text>
      {signers.map((s, i) => (
        <View key={s.from + s.keyType + s.key + s.principals.join(',')} testID={`trusted-signer-${i}`} style={styles.signer}>
          <View style={styles.signerText}>
            <Text style={styles.body}>{s.principals.map((p) => t.signerPrincipal(shownPrincipal(p))).join(', ')}</Text>
            <Text style={styles.mono} selectable>
              {`${s.keyType} ${s.fingerprint}`}
            </Text>
            <Text style={styles.help}>{t.trustedFrom(libraryHost(s.from))}</Text>
            {withdrawn.some((w) => w.from === s.from && sameSigner(w, s)) ? (
              <Text testID={`trusted-signer-withdrawn-${i}`} style={styles.error}>
                {t.trustedWithdrawn}
              </Text>
            ) : null}
          </View>
          <Pressable
            testID={`trusted-signer-remove-${i}`}
            accessibilityRole="button"
            accessibilityLabel={`${t.trustedRemove} ${s.principals.join(', ')}`}
            onPress={() => removeTrustedSigner(s)}
            style={styles.removeButton}
          >
            <Text style={styles.removeText}>{t.trustedRemove}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

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
  // As the other settings' buttons (HostList.tsx).
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  disabled: { opacity: 0.5 },
  ok: { fontSize: 13, color: colors.ok, marginTop: 8 },
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  qrBox: { alignItems: 'center', marginTop: 12 },
  signer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 8,
  },
  signerText: { flex: 1 },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  mono: { fontSize: 12, color: colors.muted, fontFamily: mono },
  removeButton: { paddingVertical: 8, paddingHorizontal: 6 },
  removeText: { fontSize: 15, color: colors.link },
}));

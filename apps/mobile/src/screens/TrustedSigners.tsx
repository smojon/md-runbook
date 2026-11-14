/**
 * Hosts & settings → Trusted signers: the one list of keys whose signatures the app counts, for
 * the team library and run reports alike (signing/trust.ts). Each entry says where it counts: the
 * library it was trusted from (that library's runbooks only), or "added by you" (every runbook);
 * a library's key it no longer publishes is flagged. Remove, and Add for pasted allowed_signers
 * lines.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { libraryHost, useLibrary, withdrawnKeys } from '../runbooks/library';
import { addSigners, isAddedByYou, removeTrustedSigner, sameSigner, shownPrincipal, useTrustedSigners } from '../signing/trust';
import { mono, themedStyles, usePalette } from '../theme';

export function TrustedSignersSection() {
  const styles = useStyles();
  const colors = usePalette();
  const signers = useTrustedSigners();
  const lib = useLibrary();
  // The library read now: its keys it no longer lists are flagged even before they are marked so.
  const withdrawnNow = lib.library ? withdrawnKeys(lib.library) : [];
  const [draft, setDraft] = useState('');
  const [added, setAdded] = useState<ReturnType<typeof addSigners> | undefined>();
  const add = (): void => {
    setAdded(addSigners(draft));
    setDraft('');
  };
  return (
    <View testID="trusted-signers" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.trustedSignersTitle}</Text>
      <Text style={styles.help}>{signers.length > 0 ? t.trustedSignersHelp : t.trustedSignersNone}</Text>
      {signers.map((s, i) => {
        const withdrawn = !isAddedByYou(s) && (s.withdrawn || withdrawnNow.some((w) => w.from === s.from && sameSigner(w, s)));
        return (
          <View
            key={s.from + ' ' + s.keyType + ' ' + s.key + ' ' + s.principals.join(',')}
            testID={`trusted-signer-${i}`}
            style={styles.signer}
          >
            <View style={styles.signerText}>
              <Text style={styles.body}>{s.principals.map((p) => t.signerPrincipal(shownPrincipal(p))).join(', ')}</Text>
              <Text style={styles.mono} selectable>
                {`${s.keyType} ${s.fingerprint}`}
              </Text>
              <Text testID={`trusted-signer-scope-${i}`} style={styles.help}>
                {isAddedByYou(s) ? t.trustedByYou : t.trustedFrom(libraryHost(s.from))}
              </Text>
              {withdrawn ? (
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
        );
      })}
      <Text style={styles.label}>{t.trustedAddLabel}</Text>
      <Text style={styles.help}>{t.trustedAddHelp}</Text>
      <TextInput
        testID="trusted-signers-add"
        accessibilityLabel={t.trustedAddLabel}
        style={[styles.input, styles.monoInput]}
        value={draft}
        onChangeText={(v) => {
          setDraft(v);
          setAdded(undefined);
        }}
        placeholder={t.trustedSignersPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <Pressable
        testID="trusted-signers-add-go"
        accessibilityRole="button"
        disabled={draft.trim() === ''}
        onPress={add}
        style={[styles.button, draft.trim() === '' && styles.disabled]}
      >
        <Text style={styles.buttonText}>{t.trustedAddGo}</Text>
      </Pressable>
      {added ? (
        <Text testID="trusted-signers-added" style={added.added > 0 ? styles.ok : styles.error}>
          {t.trustedAdded(added.added, added.already, added.skipped)}
        </Text>
      ) : null}
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
  monoInput: { fontFamily: mono, fontSize: 13, minHeight: 64 },
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

/**
 * Team runbooks on the runbook list: the library's runbooks by folder, each with its signature,
 * the user's copy and its updates; the library's signers to trust (asked first). Nothing shows
 * when there is no library.
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import {
  Library,
  LibraryEntry,
  UpdateWarning,
  applyUpdate,
  copyStatus,
  keepMine,
  openLibraryRunbook,
  openableReason,
  planUpdate,
  recheckSignatures,
  refreshLibrary,
  useLibrary,
} from '../runbooks/library';
import { libraryCopy, useRunbooks } from '../runbooks/store';
import { useLibraryUrlSetting } from '../settings/store';
import { SignatureState, isTrustedSigner, signatureState, trustSigners, untrustSigners, useTrustedSigners } from '../signing/trust';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';

export function sigLabel(s: SignatureState | undefined): string {
  if (!s) return t.libraryChecking;
  switch (s.kind) {
    case 'verified':
      return t.sigVerified(s.signers);
    case 'unknown':
      return t.sigUnknown;
    case 'unsigned':
      return t.sigUnsigned;
    case 'changed':
      return t.sigChanged;
    case 'invalid':
      return t.sigInvalid(s.signers);
  }
}

const expiredOn = (s: SignatureState | undefined): string | undefined =>
  s && (s.kind === 'verified' || s.kind === 'unknown') && s.expires && s.expires < new Date().toISOString().slice(0, 10)
    ? s.expires
    : undefined;

export function LibrarySection() {
  const styles = useStyles();
  const colors = usePalette();
  const lib = useLibrary();
  const trusted = useTrustedSigners();
  const setAddress = useLibraryUrlSetting();
  // Trusting or forgetting a signer changes what each runbook's signature is worth.
  useEffect(() => {
    void recheckSignatures();
  }, [trusted]);
  if (lib.status === 'idle' || lib.status === 'none') return null;
  // The web app's own /runbooks/ (no address set), never read: a failure there is no library, not an error.
  if (!lib.library && lib.status === 'error' && !setAddress) return null;
  const library = lib.library;
  const heading = (
    <View style={styles.headingRow}>
      <Text style={styles.section} role="heading">
        {t.librarySection}
      </Text>
      <Pressable
        testID="library-refresh"
        accessibilityRole="button"
        aria-label={t.libraryRefresh}
        accessibilityLabel={t.libraryRefresh}
        hitSlop={8}
        onPress={() => void refreshLibrary({ force: true })}
        style={styles.refresh}
      >
        {lib.busy ? <ActivityIndicator size="small" color={colors.muted} /> : <Codicon name="refresh" size={16} color={colors.muted} />}
      </Pressable>
    </View>
  );
  if (!library) {
    return (
      <View testID="library">
        {heading}
        <Text testID="library-state" role={lib.error ? 'alert' : undefined} style={lib.error ? styles.error : styles.meta}>
          {lib.error ? t.libraryFailed(lib.error) : t.libraryLoading}
        </Text>
      </View>
    );
  }
  const folders = [...new Set(library.entries.map((e) => e.folder))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  return (
    <View testID="library">
      {heading}
      {lib.error ? <Text style={styles.meta}>{t.libraryStale(lib.error)}</Text> : null}
      {library.signers && library.signers.list.length > 0 ? <SignersCard library={library} /> : null}
      {library.entries.length === 0 ? <Text style={styles.meta}>{t.libraryEmpty}</Text> : null}
      {folders.map((folder) => {
        const entries = library.entries.filter((e) => e.folder === folder);
        return (
          <View key={folder || '-'}>
            {folder ? (
              <Text style={[styles.section, styles.folder]} role="heading">
                {t.libraryFolder(folder)}
              </Text>
            ) : null}
            {entries.map((e, i) => (
              <LibraryRow
                key={e.path}
                library={library}
                entry={e}
                sig={lib.signatures[e.path]}
                first={i === 0}
                last={i === entries.length - 1}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

/** The library's allowed_signers: offered to trust, after showing who and which keys, never silently. */
function SignersCard({ library }: { library: Library }) {
  const styles = useStyles();
  useTrustedSigners();
  const [asking, setAsking] = useState(false);
  const list = library.signers!.list;
  const untrusted = list.filter((s) => !isTrustedSigner(s));
  const host = new URL(library.base).host;
  return (
    <View testID="library-signers" style={styles.card}>
      <Text style={styles.body}>{untrusted.length > 0 ? t.librarySigners(list.length) : t.trustedSigners(list.length)}</Text>
      {library.signers!.skipped > 0 ? <Text style={styles.meta}>{t.librarySignersSkipped(library.signers!.skipped)}</Text> : null}
      {asking ? (
        <View testID="library-trust-prompt">
          <Text style={[styles.body, styles.warn]}>{t.trustSignersPrompt(host)}</Text>
          {untrusted.map((s) => (
            <View key={s.keyType + s.key + s.principals.join(',')} style={styles.signer}>
              <Text style={styles.body}>{s.principals.join(', ')}</Text>
              <Text style={styles.mono} selectable>
                {`${s.keyType} ${s.fingerprint}`}
              </Text>
            </View>
          ))}
          <View style={styles.buttons}>
            <Pressable
              testID="library-trust-go"
              accessibilityRole="button"
              onPress={() => {
                trustSigners(untrusted, library.base);
                setAsking(false);
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>{t.trustSignersGo}</Text>
            </Pressable>
            <Pressable testID="library-trust-cancel" accessibilityRole="button" onPress={() => setAsking(false)} style={styles.secondary}>
              <Text style={styles.secondaryText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : untrusted.length > 0 ? (
        <View style={styles.buttons}>
          <Pressable testID="library-trust" accessibilityRole="button" onPress={() => setAsking(true)} style={styles.tinted}>
            <Text style={styles.tintedText}>{t.trustSigners}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.buttons}>
          <Pressable testID="library-untrust" accessibilityRole="button" onPress={() => untrustSigners(list)} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t.untrustSigners}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function warningText(w: UpdateWarning): string {
  switch (w.kind) {
    case 'lost-outputs':
      return t.updateLostOutputs(w.count);
    case 'own-edits':
      return t.updateOwnEdits;
    case 'signature-dropped':
      return t.updateSignatureDropped(w.was);
    case 'other-signer':
      return t.updateOtherSigner(w.was, w.now);
    case 'signature-broken':
      return t.updateSignatureBroken(w.was);
  }
}

function LibraryRow({
  library,
  entry,
  sig,
  first,
  last,
}: {
  library: Library;
  entry: LibraryEntry;
  sig: SignatureState | undefined;
  first: boolean;
  last: boolean;
}) {
  const styles = useStyles();
  const colors = usePalette();
  useRunbooks();
  const copy = libraryCopy(library.base, entry.path);
  const why = copy ? undefined : openableReason(library, entry, sig);
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<{ text: string; warnings: UpdateWarning[] } | undefined>();
  const status = copy ? copyStatus(copy, entry) : 'current';
  const expired = expiredOn(sig);
  const sigColor =
    sig?.kind === 'verified' ? colors.ok : sig?.kind === 'invalid' || sig?.kind === 'changed' ? colors.warningText : colors.muted;
  const open = async (): Promise<void> => {
    setError(undefined);
    const r = await openLibraryRunbook(library, entry);
    if (r.kind === 'error') setError(r.message);
    else router.push({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
  };
  const update = async (force: boolean): Promise<void> => {
    if (!copy || entry.text === undefined || entry.hash === undefined) return;
    setError(undefined);
    const next = sig ?? (await signatureState(entry.text));
    const refused = openableReason(library, entry, next);
    if (refused) return setError(t.updateRefused(refused));
    const plan = planUpdate(copy, { ...entry, text: entry.text }, next);
    if (plan.warnings.length > 0 && !force) return setConfirm(plan);
    applyUpdate(copy.id, library.base, { ...entry, text: entry.text, hash: entry.hash }, plan.text);
    setConfirm(undefined);
  };
  return (
    <View style={[styles.row, first && styles.rowFirst, last && styles.rowLast]}>
      <Pressable
        testID={`library-${entry.path}`}
        accessibilityRole="link"
        aria-label={entry.title}
        aria-disabled={why !== undefined}
        disabled={why !== undefined}
        onPress={() => void open()}
        style={styles.rowLink}
      >
        <View style={styles.badge}>
          <Codicon name={sig?.kind === 'verified' ? 'verified' : 'library'} size={18} color={why ? colors.muted : colors.link} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.title, why !== undefined && styles.dim]} numberOfLines={2}>
            {entry.title}
          </Text>
          <Text testID={`library-sig-${entry.path}`} style={[styles.meta, { color: sigColor }]} numberOfLines={2}>
            {entry.text === undefined ? (entry.error ?? t.libraryUnreadable) : sigLabel(sig)}
            {expired ? ` · ${t.sigExpired(expired)}` : ''}
            {copy ? ` · ${t.libraryYourCopy}` : ''}
            {status === 'kept' ? ` · ${t.updateKept}` : ''}
          </Text>
          {why && entry.text !== undefined ? (
            <Text testID={`library-why-${entry.path}`} style={styles.meta}>
              {why}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {status === 'update' && !confirm ? (
        <View testID={`library-update-${entry.path}`} style={styles.update}>
          <Text style={[styles.meta, styles.updateText]}>{t.updateAvailable}</Text>
          <Pressable
            testID={`library-update-go-${entry.path}`}
            accessibilityRole="button"
            onPress={() => void update(false)}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{t.updateGo}</Text>
          </Pressable>
          <Pressable
            testID={`library-keep-${entry.path}`}
            accessibilityRole="button"
            onPress={() => copy && keepMine(copy.id, entry)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{t.keepMine}</Text>
          </Pressable>
        </View>
      ) : null}
      {confirm ? (
        <View testID={`library-update-confirm-${entry.path}`} style={styles.confirm}>
          {confirm.warnings.map((w) => (
            <Text key={w.kind} style={[styles.meta, styles.warn]}>
              {warningText(w)}
            </Text>
          ))}
          <View style={styles.buttons}>
            <Pressable
              testID={`library-update-anyway-${entry.path}`}
              accessibilityRole="button"
              onPress={() => void update(true)}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>{t.updateAnyway}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setConfirm(undefined)} style={styles.secondary}>
              <Text style={styles.secondaryText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text role="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 8 },
  section: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: 4,
  },
  folder: { marginTop: 20, marginBottom: 8 },
  refresh: { padding: 6, minWidth: 28, alignItems: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 6,
  },
  signer: { paddingVertical: 4 },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  mono: { fontSize: 12, color: colors.muted, fontFamily: mono },
  warn: { color: colors.warningText },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  rowLink: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  badge: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '500', color: colors.text },
  dim: { color: colors.muted },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  update: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingBottom: 12 },
  updateText: { flex: 1, color: colors.link, fontWeight: '600', marginTop: 0 },
  confirm: { paddingBottom: 12, gap: 4 },
  primary: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.accent },
  primaryText: { fontSize: 14, fontWeight: '600', color: colors.onAccent },
  tinted: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: colors.accentSoft },
  tintedText: { fontSize: 14, fontWeight: '600', color: colors.link },
  secondary: { paddingVertical: 8, paddingHorizontal: 6 },
  secondaryText: { fontSize: 15, color: colors.link },
  error: { fontSize: 13, color: colors.error, marginTop: 4, paddingBottom: 8 },
}));

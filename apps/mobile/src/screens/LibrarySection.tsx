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
  SignedFacts,
  UpdateWarning,
  allowUnverified,
  applyUpdate,
  copyStatus,
  highestVersion,
  keepMine,
  libraryHost,
  libraryKeys,
  looksVerified,
  openLibraryRunbook,
  openableReason,
  planUpdate,
  recheckSignatures,
  refreshLibrary,
  signatureOf,
  signedFacts,
  useLibrary,
  withdrawnKeys,
} from '../runbooks/library';
import { Runbook, libraryCopy, useRunbooks } from '../runbooks/store';
import { useLibraryUrlSetting } from '../settings/store';
import {
  SignatureState,
  SignerCheck,
  isTrustedSigner,
  manifestOf,
  shownName,
  shownPrincipal,
  signatureState,
  trustSigners,
  trustedFor,
  untrustSigners,
  useTrustedSigners,
} from '../signing/trust';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';
import { compareWithHint, signerHintFor, useSignerHints } from '../pairing/signerHints';

const signerNames = (checks: readonly SignerCheck[]): string[] =>
  checks.map((c) => t.sigSigner(c.name, c.wildcard ? c.fingerprint : undefined));

/** What a runbook's signature is worth, in a few words: the same in the list and in the opened copy's banner. */
export function sigLabel(s: SignatureState | undefined): string {
  if (!s) return t.libraryChecking;
  switch (s.kind) {
    case 'verified':
      return t.sigVerified(signerNames(s.verified), s.coverage);
    case 'expired':
      return t.sigExpiredState(signerNames(s.verified), s.manifest.expires ?? '?');
    case 'partial':
      return t.sigPartial(s.unsigned);
    case 'unknown':
      return t.sigUnknown;
    case 'unsigned':
      return t.sigUnsigned;
    case 'changed':
      return t.sigChanged;
    case 'invalid':
      return t.sigInvalid(s.signers.map(shownName));
  }
}

/** The signed name and version, and what is wrong with them: another name than the file's, a downgrade, an expiry. */
export function factsLabel(facts: SignedFacts | undefined, s: SignatureState | undefined): string | undefined {
  if (!facts) return undefined;
  return [
    t.sigManifest(facts.name, facts.version),
    ...(facts.otherName ? [t.sigOtherName] : []),
    ...(facts.olderThan !== undefined ? [t.sigOlder(facts.olderThan)] : []),
    // An expired state says it already.
    ...(facts.expired && s?.kind !== 'expired' ? [t.sigExpired(facts.expired)] : []),
  ].join(' · ');
}

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
      {library.signedOnlyDropped ? (
        <View testID="library-signed-only-dropped" style={styles.card}>
          <Text style={[styles.body, styles.warn]}>{t.librarySignedOnlyDropped}</Text>
          <View style={styles.buttons}>
            <Pressable
              testID="library-allow-unverified"
              accessibilityRole="button"
              onPress={() => allowUnverified(library.base)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>{t.libraryAllowUnverified}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {(library.signers && library.signers.list.length > 0) || withdrawnKeys(library).length > 0 ? <SignersCard library={library} /> : null}
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
                sig={signatureOf(lib, e)}
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

/**
 * The library's allowed_signers: offered to trust for this library only, after showing who (and
 * what a pattern lets a key sign as) and which keys, never silently; keys it no longer publishes.
 */
function SignersCard({ library }: { library: Library }) {
  const styles = useStyles();
  useTrustedSigners();
  const [asking, setAsking] = useState(false);
  const list = library.signers?.list ?? [];
  const untrusted = list.filter((s) => !isTrustedSigner(s, library.base));
  const withdrawn = withdrawnKeys(library);
  const host = libraryHost(library.base);
  // What the other device trusts for this library (a pairing link brought it): compared, never trusted.
  useSignerHints();
  const hint = signerHintFor(library.base);
  const other = hint && list.length > 0 ? compareWithHint(list, hint) : undefined;
  return (
    <View testID="library-signers" style={styles.card}>
      {list.length > 0 ? (
        <Text style={styles.body}>{untrusted.length > 0 ? t.librarySigners(list.length) : t.trustedSigners(list.length)}</Text>
      ) : null}
      {library.signers && library.signers.skipped > 0 ? (
        <Text style={styles.meta}>{t.librarySignersSkipped(library.signers.skipped)}</Text>
      ) : null}
      {withdrawn.length > 0 ? (
        <View testID="library-signers-withdrawn">
          <Text style={[styles.body, styles.warn]}>{t.signersWithdrawn(withdrawn.length)}</Text>
          <View style={styles.buttons}>
            <Pressable
              testID="library-untrust-withdrawn"
              accessibilityRole="button"
              onPress={() => untrustSigners(withdrawn, library.base)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>{t.untrustWithdrawn}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {list.length === 0 ? null : asking ? (
        <View testID="library-trust-prompt">
          <Text style={[styles.body, styles.trustTitle]} role="heading">
            {t.trustSignersTitle(host)}
          </Text>
          <View testID="library-trust-points" style={styles.points}>
            {t.trustSignersPoints.map((p) => (
              <View key={p} style={styles.point}>
                <Text style={styles.body}>{'•'}</Text>
                <Text style={[styles.body, styles.pointText]}>{p}</Text>
              </View>
            ))}
          </View>
          {other ? (
            <Text testID="library-signers-other" style={other.same ? styles.body : [styles.body, styles.warn]}>
              {other.same ? t.signersSameAsOther : t.signersDifferFromOther(other.notThere, other.missingHere)}
            </Text>
          ) : null}
          {untrusted.map((s) => (
            <View key={s.keyType + s.key + s.principals.join(',')} style={styles.signer}>
              <Text style={styles.body}>{s.principals.map((p) => t.signerPrincipal(shownPrincipal(p))).join(', ')}</Text>
              <Text style={styles.mono} selectable>
                {`${s.keyType} ${s.fingerprint}`}
              </Text>
              {other ? (
                <Text
                  testID={other.trustedThere.has(s.fingerprint) ? 'library-signer-other-yes' : 'library-signer-other-no'}
                  style={other.trustedThere.has(s.fingerprint) ? styles.meta : [styles.meta, styles.warn]}
                >
                  {other.trustedThere.has(s.fingerprint) ? t.signerTrustedOther : t.signerNotTrustedOther}
                </Text>
              ) : null}
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
          <Pressable
            testID="library-untrust"
            accessibilityRole="button"
            onPress={() => untrustSigners(trustedFor(library.base), library.base)}
            style={styles.secondary}
          >
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
    case 'partly-signed':
      return t.updatePartlySigned(w.count);
    case 'expired':
      return t.updateExpired(w.on);
    case 'older-version':
      return t.updateOlderVersion(w.name, w.now, w.seen);
  }
}

/** The copy's own signature state, when its library opens verified runbooks only (checked as the library's file is). */
function useCopyState(library: Library, copy: Runbook | undefined): SignatureState | undefined {
  const trusted = useTrustedSigners();
  const text = copy && library.signedOnly ? copy.text : undefined;
  const [got, setGot] = useState<{ text: string; state: SignatureState } | undefined>();
  useEffect(() => {
    if (text === undefined) return;
    let live = true;
    void signatureState(text, libraryKeys(library)).then((state) => {
      if (live) setGot({ text, state });
    });
    return () => {
      live = false;
    };
  }, [text, library, trusted]);
  return got && got.text === text ? got.state : undefined;
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
  const copyState = useCopyState(library, copy);
  /** signedOnly: why the user's copy is refused (unsigned, edited, older than a version seen, …). */
  const mineWhy =
    copy && library.signedOnly && copyState ? openableReason(library, { text: copy.text, path: entry.path }, copyState) : undefined;
  /**
   * A refused copy is never a dead end: the library's version, when it opens, replaces it (with
   * the update's warnings), whether or not the copy is behind it.
   */
  const replace = mineWhy !== undefined && entry.hash !== undefined && openableReason(library, entry, sig) === undefined;
  /**
   * signedOnly: the library's version is offered only when the library would open it (the check
   * Update makes again on the text it takes); otherwise the row says why, with no Update or Keep
   * mine. Not offered either until its signature is checked.
   */
  const theirsChecking = copy !== undefined && library.signedOnly === true && sig === undefined;
  const theirsWhy = copy && library.signedOnly && sig !== undefined ? openableReason(library, entry, sig) : undefined;
  const offer = theirsWhy === undefined && !theirsChecking;
  const [error, setError] = useState<string | undefined>();
  /** The update's warnings, for the library's text with this hash (a newer text asks again). */
  const [confirm, setConfirm] = useState<{ text: string; warnings: UpdateWarning[]; hash: string } | undefined>();
  const status = copy ? copyStatus(copy, entry) : 'current';
  // Keep mine would leave a copy the library refuses: not offered then (Replace is).
  const canKeep = status === 'update' && (!library.signedOnly || (copyState !== undefined && mineWhy === undefined));
  const facts = signedFacts(library.base, entry.path, sig);
  const green = looksVerified(sig, facts);
  // Verified but not green: under another name than the file's, or a downgrade.
  const sigColor = green
    ? colors.ok
    : sig?.kind === 'invalid' || sig?.kind === 'changed' || sig?.kind === 'partial' || sig?.kind === 'expired' || sig?.kind === 'verified'
      ? colors.warningText
      : colors.muted;
  const open = async (): Promise<void> => {
    setError(undefined);
    const r = await openLibraryRunbook(library, entry);
    if (r.kind === 'error') setError(r.message);
    else router.push({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
  };
  const update = async (force: boolean): Promise<void> => {
    if (!copy || entry.text === undefined || entry.hash === undefined) return;
    const text = entry.text;
    // "Update anyway" answers the warnings shown for this text: refreshed since, the new text asks again.
    const sure = force && confirm?.hash === entry.hash;
    setError(undefined);
    // Always checked again here, on the text being taken: never a state kept from an earlier read.
    const next = await signatureState(text, libraryKeys(library));
    const refused = openableReason(library, entry, next);
    if (refused) return setError(t.updateRefused(refused));
    const m = manifestOf(next);
    const plan = planUpdate(copy, { ...entry, text }, next, m ? highestVersion(library.base, entry.path, m.name) : undefined);
    if (plan.warnings.length > 0 && !sure) return setConfirm({ ...plan, hash: entry.hash });
    applyUpdate(copy.id, library.base, { ...entry, text, hash: entry.hash }, plan.text);
    setConfirm(undefined);
  };
  const factsText = factsLabel(facts, sig);
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
          <Codicon name={green ? 'verified' : 'library'} size={18} color={why ? colors.muted : colors.link} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.title, why !== undefined && styles.dim]} numberOfLines={2}>
            {entry.title}
          </Text>
          <Text testID={`library-sig-${entry.path}`} style={[styles.meta, { color: sigColor }]} numberOfLines={3}>
            {entry.text === undefined ? (entry.error ?? t.libraryUnreadable) : sigLabel(sig)}
            {copy ? ` · ${t.libraryYourCopy}` : ''}
            {status === 'kept' ? ` · ${t.updateKept}` : ''}
          </Text>
          {factsText ? (
            <Text
              testID={`library-facts-${entry.path}`}
              style={[styles.meta, facts?.otherName || facts?.olderThan !== undefined || facts?.expired ? styles.warn : null]}
              numberOfLines={2}
            >
              {factsText}
            </Text>
          ) : null}
          {why && entry.text !== undefined ? (
            <Text testID={`library-why-${entry.path}`} style={styles.meta}>
              {why}
            </Text>
          ) : null}
          {mineWhy ? (
            <Text testID={`library-copy-why-${entry.path}`} style={[styles.meta, styles.warn]}>
              {t.libraryCopyRefused(mineWhy)}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {status === 'update' && theirsWhy !== undefined ? (
        <Text testID={`library-update-refused-${entry.path}`} style={[styles.meta, styles.warn, styles.update]}>
          {t.libraryVersionRefused(theirsWhy)}
        </Text>
      ) : null}
      {(status === 'update' || replace) && offer && !confirm ? (
        <View testID={`library-update-${entry.path}`} style={styles.update}>
          <Text style={[styles.meta, styles.updateText]}>{replace ? t.libraryReplaceHelp : t.updateAvailable}</Text>
          <Pressable
            testID={replace ? `library-replace-${entry.path}` : `library-update-go-${entry.path}`}
            accessibilityRole="button"
            onPress={() => void update(false)}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{replace ? t.libraryReplace : t.updateGo}</Text>
          </Pressable>
          {canKeep ? (
            <Pressable
              testID={`library-keep-${entry.path}`}
              accessibilityRole="button"
              onPress={() => copy && keepMine(copy.id, entry)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>{t.keepMine}</Text>
            </Pressable>
          ) : null}
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
  trustTitle: { fontWeight: '600', marginBottom: 4 },
  points: { gap: 4, marginBottom: 8 },
  point: { flexDirection: 'row', gap: 8 },
  pointText: { flex: 1 },
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

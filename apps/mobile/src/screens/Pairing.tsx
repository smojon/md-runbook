/**
 * Pairing (pairing/payload.ts), both sides:
 *
 * - PairDeviceCard, Hosts & settings → Relay → Pair a device (the laptop): a QR code with the
 *   relay's address and token, and the hosts with their host keys when ticked. It says the code
 *   holds a secret and hides itself after a minute (Show again). Copy pairing link copies the
 *   same as a link with the payload in its fragment.
 * - PairScreen, /pair (the phone's browser): a scanned code, or a pairing link opened. It asks
 *   first; then saves the relay, adds the hosts (their keys trusted only when ticked, as Import
 *   hosts does) and shows this device's public key for the servers' authorized_keys.
 */
import { qrMatrix } from '@md-runbook/core/qr';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { importHosts, sharedHosts } from '../hosts/share';
import { useHosts } from '../hosts/store';
import { t } from '../i18n';
import { decodePairing, encodePairing, pairingLink } from '../pairing/payload';
import { capturePairingFragment, clearPendingPairing, pendingPairing } from '../pairing/pending';
import { publicBaseOf, toPublicRelayUrl } from '../settings/publicAddress';
import { useRuntimeConfig } from '../settings/runtimeConfig';
import { appPublicKeyLine } from '../ssh/appKey';
import { RelaySettings, getRelaySettings, setRelaySettings } from '../ssh/relaySettings';
import { mono, themedStyles } from '../theme';
import { QrView } from '../ui/QrView';
import { Toggle } from '../ui/Toggle';

/** How long the pairing code stays on screen. */
export const PAIR_SHOW_MS = 60_000;
/** Past this many modules a side, a code shown on a screen is hard for a phone to read. */
export const PAIR_LARGE_MODULES = 89;

const isLocal = (url: string): boolean => {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function PairDeviceCard({ onClose }: { onClose(): void }) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const hosts = useHosts();
  useRuntimeConfig();
  /** null while it is read. */
  const [relay, setRelay] = useState<RelaySettings | undefined | null>(null);
  useEffect(() => {
    let live = true;
    void getRelaySettings().then((s) => live && setRelay(s));
    return () => {
      live = false;
    };
  }, []);
  const [withHosts, setWithHosts] = useState(false);
  const [hidden, setHidden] = useState(false);
  /** Bumped by Show again: the minute starts over. */
  const [shown, setShown] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (hidden) return;
    const timer = setTimeout(() => setHidden(true), PAIR_SHOW_MS);
    return () => clearTimeout(timer);
  }, [hidden, shown]);
  const pub = publicBaseOf();
  const payload = useMemo(
    () =>
      relay
        ? encodePairing({
            relay: toPublicRelayUrl(relay.url),
            token: relay.token,
            ...(withHosts ? { hosts: sharedHosts(hosts, true) } : {}),
          })
        : undefined,
    [relay, withHosts, hosts],
  );
  const matrix = useMemo(() => (payload && !hidden ? qrMatrix(payload) : undefined), [payload, hidden]);
  const copyLink = async (): Promise<void> => {
    if (!payload || !pub) return;
    await Clipboard.setStringAsync(pairingLink(pub.base, payload));
    setCopied(true);
  };
  return (
    <View testID="pair-device" style={styles.card}>
      <Text style={styles.title}>{t.pairDevice}</Text>
      <Text style={styles.help}>{t.pairDeviceHelp}</Text>
      {relay === undefined ? (
        <Text testID="pair-needs-relay" style={styles.error}>
          {t.pairNeedsRelay}
        </Text>
      ) : null}
      {relay ? (
        <>
          <Text testID="pair-warning" role="alert" style={styles.warning}>
            {t.pairSecretWarning}
          </Text>
          {pub ? (
            <Text style={styles.help}>
              {pub.source === 'page' && isLocal(pub.base) ? t.pairUnreachable(pub.base) : t.pairFor(pub.base)}
            </Text>
          ) : null}
          {hosts.length > 0 ? (
            <View style={styles.switchRow}>
              <Text style={[styles.label, styles.grow]}>{t.pairWithHosts}</Text>
              <Toggle testID="pair-with-hosts" accessibilityLabel={t.pairWithHosts} value={withHosts} onValueChange={setWithHosts} />
            </View>
          ) : null}
          {hidden ? (
            <View testID="pair-hidden">
              <Text style={styles.help}>{t.pairHidden}</Text>
              <Pressable
                testID="pair-show-again"
                accessibilityRole="button"
                onPress={() => {
                  setHidden(false);
                  setShown(shown + 1);
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>{t.pairShowAgain}</Text>
              </Pressable>
            </View>
          ) : matrix ? (
            <View style={styles.qrBox}>
              <QrView testID="pair-code" matrix={matrix} size={Math.min(width - 64, 360)} />
              {matrix.size > PAIR_LARGE_MODULES ? (
                <Text testID="pair-large" style={styles.help}>
                  {t.pairLarge(matrix.size)}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text testID="pair-too-large" style={styles.error}>
              {t.pairTooLarge}
            </Text>
          )}
          <View style={styles.row}>
            {hidden ? null : (
              <Pressable testID="pair-hide" accessibilityRole="button" onPress={() => setHidden(true)} style={styles.button}>
                <Text style={styles.buttonText}>{t.pairHide}</Text>
              </Pressable>
            )}
            <Pressable
              testID="pair-copy-link"
              accessibilityRole="button"
              disabled={!pub}
              onPress={() => void copyLink()}
              style={[styles.button, !pub && styles.disabled]}
            >
              <Text style={styles.buttonText}>{t.pairCopyLink}</Text>
            </Pressable>
          </View>
          {copied ? (
            <Text testID="pair-link-copied" role="alert" style={styles.warning}>
              {t.pairLinkCopied}
            </Text>
          ) : null}
        </>
      ) : null}
      <Pressable testID="pair-close" accessibilityRole="button" onPress={onClose} style={styles.close}>
        <Text style={styles.link}>{t.close}</Text>
      </Pressable>
    </View>
  );
}

/** This device's public key, to add to the servers' authorized_keys: Copy, and as a QR code. */
export function DeviceKeyCard() {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const [line, setLine] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);
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
  const matrix = qr && line ? qrMatrix(line) : undefined;
  return (
    <View testID="device-key" style={styles.card}>
      <Text style={styles.title}>{t.pairKeyTitle}</Text>
      <Text style={styles.label}>{t.pairKeyLabel}</Text>
      {error ? (
        <Text style={styles.error}>{t.appKeyFailed(error)}</Text>
      ) : (
        <Text testID="device-public-key" style={styles.key} selectable>
          {line ?? t.appKeyLoading}
        </Text>
      )}
      <Text style={styles.help}>{t.pairKeyHelp}</Text>
      <View style={styles.row}>
        <Pressable
          testID="device-key-copy"
          accessibilityRole="button"
          disabled={!line}
          onPress={() => {
            if (!line) return;
            void Clipboard.setStringAsync(line).then(() => setCopied(true));
          }}
          style={[styles.button, !line && styles.disabled]}
        >
          <Text style={styles.buttonText}>{copied ? t.copied : t.copy}</Text>
        </Pressable>
        <Pressable
          testID="device-key-qr"
          accessibilityRole="button"
          aria-expanded={qr}
          disabled={!line}
          onPress={() => setQr(!qr)}
          style={[styles.button, !line && styles.disabled]}
        >
          <Text style={styles.buttonText}>{t.pairKeyQr}</Text>
        </Pressable>
      </View>
      {matrix ? (
        <View style={styles.qrBox}>
          <QrView testID="device-key-code" matrix={matrix} size={Math.min(width - 64, 300)} />
        </View>
      ) : null}
    </View>
  );
}

/** /pair: the pairing a link or a scanned code brought, set up once the user says so. */
export function PairScreen() {
  const styles = useStyles();
  const existing = useHosts();
  // A link opened straight at /pair#…: read here too, should the app not have read it at load.
  const [pending] = useState(() => {
    capturePairingFragment();
    return pendingPairing();
  });
  const read = useMemo(() => (pending ? decodePairing(pending.payload) : undefined), [pending]);
  const pairing = read && 'pairing' in read ? read.pairing : undefined;
  const [current, setCurrent] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void getRelaySettings().then((s) => live && setCurrent(s?.url));
    return () => {
      live = false;
    };
  }, []);
  const have = new Set(existing.map((h) => h.name.toLowerCase()));
  const hosts = pairing?.hosts ?? [];
  const fresh = hosts.filter((h) => !have.has(h.name.toLowerCase()));
  const [addHosts, setAddHosts] = useState(true);
  const [trustKeys, setTrustKeys] = useState(false);
  const [answer, setAnswer] = useState<{ kind: 'done'; added: number; skipped: number } | { kind: 'declined' } | undefined>();

  const apply = async (): Promise<void> => {
    if (!pairing) return;
    await setRelaySettings({ url: pairing.relay, token: pairing.token });
    const imported = addHosts && hosts.length > 0 ? importHosts(hosts, trustKeys) : { added: [], skipped: [] };
    clearPendingPairing();
    setAnswer({ kind: 'done', added: imported.added.length, skipped: imported.skipped.length });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {!pending ? (
        <Text testID="pair-none" style={styles.help}>
          {t.pairNone}
        </Text>
      ) : read && !pairing ? (
        <Text testID="pair-problem" role="alert" style={styles.error}>
          {'error' in read ? read.error : 'problem' in read ? t.pairProblem[read.problem] : ''}
        </Text>
      ) : pairing && !answer ? (
        <View testID="pair-ask" style={styles.card}>
          <Text style={styles.title}>{pending.source === 'link' ? t.pairAskLink : t.pairAskCode}</Text>
          <Text style={styles.help}>{t.pairBody(pairing.relay)}</Text>
          {current && current !== pairing.relay ? <Text style={styles.warning}>{t.pairReplaces(current)}</Text> : null}
          {hosts.length > 0 ? (
            <>
              <View testID="pair-hosts" style={styles.list}>
                {hosts.map((h) => (
                  <Text key={h.name} style={have.has(h.name.toLowerCase()) ? styles.help : styles.item}>
                    {`${h.group ? `${h.group} · ` : ''}${h.name}: ${h.username}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`}`}
                    {have.has(h.name.toLowerCase()) ? ` (${t.hostsAlreadyHave})` : ''}
                  </Text>
                ))}
              </View>
              {fresh.length > 0 ? (
                <View style={styles.switchRow}>
                  <Text style={[styles.label, styles.grow]}>{t.pairAddHosts(fresh.length)}</Text>
                  <Toggle
                    testID="pair-add-hosts"
                    accessibilityLabel={t.pairAddHosts(fresh.length)}
                    value={addHosts}
                    onValueChange={setAddHosts}
                  />
                </View>
              ) : null}
              {addHosts && fresh.some((h) => h.hostKey) ? (
                <View style={styles.switchRow}>
                  <View style={styles.grow}>
                    <Text style={styles.label}>{t.hostsTrustKeys}</Text>
                    <Text style={styles.help}>{t.hostsTrustKeysHelp}</Text>
                  </View>
                  <Toggle testID="pair-trust-keys" accessibilityLabel={t.hostsTrustKeys} value={trustKeys} onValueChange={setTrustKeys} />
                </View>
              ) : null}
            </>
          ) : null}
          <View style={styles.row}>
            <Pressable testID="pair-go" accessibilityRole="button" onPress={() => void apply()} style={styles.button}>
              <Text style={styles.buttonText}>{t.pairGo}</Text>
            </Pressable>
            <Pressable
              testID="pair-not-now"
              accessibilityRole="button"
              onPress={() => {
                clearPendingPairing();
                setAnswer({ kind: 'declined' });
              }}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{t.pairNotNow}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {answer?.kind === 'declined' ? (
        <Text testID="pair-declined" style={styles.help}>
          {t.pairDeclined}
        </Text>
      ) : null}
      {answer?.kind === 'done' ? (
        <>
          <Text testID="pair-done" role="alert" style={styles.ok}>
            {t.pairDone}
            {answer.added + answer.skipped > 0 ? ` ${t.hostsImported(answer.added, answer.skipped)}` : ''}
          </Text>
          <DeviceKeyCard />
        </>
      ) : null}
      {answer || !pairing ? (
        <Pressable testID="pair-back" accessibilityRole="button" onPress={() => router.replace('/hosts')} style={styles.button}>
          <Text style={styles.buttonText}>{t.backToHosts}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, gap: 12 },
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.surface,
    gap: 4,
  },
  title: { fontSize: 16, fontWeight: '600', color: c.text, marginBottom: 4 },
  help: { fontSize: 13, color: c.muted, lineHeight: 18, marginTop: 4 },
  label: { fontSize: 14, color: c.text, marginTop: 8 },
  item: { fontSize: 14, color: c.text },
  list: { marginTop: 8, gap: 4 },
  warning: { fontSize: 13, color: c.warning, lineHeight: 18, marginTop: 8 },
  error: { fontSize: 13, color: c.error, marginTop: 8 },
  ok: { fontSize: 14, color: c.ok },
  key: {
    fontFamily: mono,
    fontSize: 12,
    color: c.text,
    backgroundColor: c.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  grow: { flex: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  qrBox: { alignItems: 'center', marginTop: 12, gap: 6 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accent,
    marginTop: 4,
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  disabled: { opacity: 0.5 },
  close: { alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: 4, marginTop: 4 },
  link: { fontSize: 15, color: c.link },
}));

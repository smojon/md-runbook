import * as Clipboard from 'expo-clipboard';
import { Link, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { VAR_NAME_RE } from '@md-runbook/core/secrets';
import { Host, hostLabel, useHosts } from '../hosts/store';
import { t } from '../i18n';
import {
  KeyStorage,
  appAllowedRunnersLine,
  appAllowedSignersLine,
  appKeyInfo,
  appPublicKeyLine,
  replaceWithUnexportableKey,
  setKeyNeedsUser,
} from '../ssh/appKey';
import { forgetConsent, loadConsents, useConsents } from '../reports/send';
import { passkeysAvailable } from '../ssh/passkey';
import { HardwareKey } from '../../modules/hardware-key';
import { webKeysAvailable } from '../ssh/webKey';
import { forgetSecret, loadSecretNames, storeSecret, useSecretNames } from '../secrets/store';
import {
  HISTORY_SIZES,
  setHistorySize,
  setOutputSetting,
  setSignerName,
  setNotifyRuns,
  setPublicUrl,
  setReportAddresses,
  useHistorySize,
  useOutputSettings,
  usePublicUrlSetting,
  useSignerName,
} from '../settings/store';
import { notificationsSupported, turnOnNotifications } from '../notifications/runs';
import {
  badTokenCharacter,
  getRelayToken,
  getRelayUrlSetting,
  relayUrlProblem,
  sameOriginRelay,
  setRelaySettings,
} from '../ssh/relaySettings';
import { publicBaseOf, toPublicRelayUrl } from '../settings/publicAddress';
import { normalizePublicUrl, publicUrlProblem, runtimeConfig, useRuntimeConfig } from '../settings/runtimeConfig';
import { cameraUsable } from '../ui/webCamera';
import { PairDeviceCard } from './Pairing';
import { SIGNER_NAME_RE } from '@md-runbook/core/signing';
import { mono, themedStyles, usePalette } from '../theme';
import { Codicon } from '../ui/Codicon';
import { Points } from '../ui/Points';
import { Toggle } from '../ui/Toggle';
import { QrView } from '../ui/QrView';
import { qrMatrix } from '@md-runbook/core/qr';
import { hostsJson, hostsLink } from '../hosts/share';
import { shareHostsFile } from '../share/export';
import { LibrarySettings } from './LibrarySettings';
import { LibraryPublishSettings } from './LibraryPublishSettings';
import { AlertPushSettings } from './AlertPushSettings';
import { TrustedSignersSection } from './TrustedSigners';

/** The hosts, the app's public key to put on them and, on the web, the relay settings. */
export function HostList() {
  const styles = useStyles();
  const colors = usePalette();
  const allHosts = useHosts();
  /** Hosts by group (a customer, a site): the chips show one group's hosts. */
  const groups = [...new Set(allHosts.flatMap((h) => (h.group ? [h.group] : [])))].sort((a, b) => a.localeCompare(b));
  const [group, setGroup] = useState<string | undefined>();
  const shown = group && groups.includes(group) ? group : undefined;
  const hosts = shown ? allHosts.filter((h) => h.group === shown) : allHosts;
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      data={hosts}
      keyExtractor={(h) => h.id}
      ListHeaderComponent={
        <>
          <Text style={styles.groupTitle} role="heading">
            {t.hostsSection}
          </Text>
          {groups.length > 0 ? (
            <View style={[styles.chips, styles.groupChips]}>
              {[undefined, ...groups].map((g) => (
                <Pressable
                  key={g ?? ''}
                  testID={`host-group-${g ?? 'all'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: shown === g }}
                  onPress={() => setGroup(g)}
                  style={[styles.chip, shown === g && styles.chipOn]}
                >
                  <Text style={[styles.chipText, shown === g && styles.chipTextOn]}>{g ?? t.allHosts}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      }
      renderItem={({ item, index }) => <HostRow host={item} first={index === 0} />}
      ListFooterComponent={
        <>
          {/* The hosts' card ends with the row that adds one. Under Link asChild a style must be one object: the web throws on an array. */}
          <Link href={{ pathname: '/hosts/[id]', params: { id: 'new' } }} asChild>
            <Pressable
              testID="add-host"
              accessibilityRole="button"
              style={StyleSheet.flatten([styles.row, hosts.length === 0 && styles.rowFirst, styles.rowLast])}
            >
              <View style={styles.badge}>
                <Codicon name="add" size={18} color={colors.link} />
              </View>
              <Text style={styles.addText}>{t.addHost}</Text>
            </Pressable>
          </Link>
          {hosts.length === 0 ? <Text style={styles.groupHelp}>{t.noHosts}</Text> : null}
          {allHosts.length > 0 ? (
            <ShareHostsSection hosts={hosts} />
          ) : (
            <Link href={{ pathname: '/hosts/import', params: {} }} asChild>
              <Pressable testID="hosts-import-open" accessibilityRole="button" style={styles.button}>
                <Text style={styles.buttonText}>{t.hostsImport}</Text>
              </Pressable>
            </Link>
          )}
          <AppKeySection />
          <SigningSection />
          <TrustedSignersSection />
          <ReportsSection />
          <SecretsSection />
          <HistorySection />
          <ColorSection />
          <LinksSection />
          <LibrarySettings />
          <LibraryPublishSettings />
          <AlertPushSettings />
          <SafetySection />
          <NotificationsSection />
          {Platform.OS === 'web' ? <PublicAddressSection /> : null}
          {Platform.OS === 'web' ? <RelaySection /> : null}
        </>
      }
    />
  );
}

function HostRow({ host, first }: { host: Host; first: boolean }) {
  const styles = useStyles();
  const colors = usePalette();
  return (
    <Link href={{ pathname: '/hosts/[id]', params: { id: host.id } }} asChild>
      <Pressable
        testID={`host-${host.id}`}
        accessibilityRole="link"
        aria-label={host.name}
        style={StyleSheet.flatten([styles.row, first && styles.rowFirst])}
      >
        <View style={styles.badge}>
          <Codicon name="server" size={18} color={colors.link} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.title}>{host.name}</Text>
          <Text style={styles.meta}>
            {host.group ? `${host.group} · ` : ''}
            {hostLabel(host)}
            {' · '}
            {host.hostKey ? t.hostKeyTrusted : t.hostKeyNotTrusted}
            {host.platform ? ` · ${t.hostPlatform[host.platform]}` : ''}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
}

function AppKeySection() {
  const styles = useStyles();
  const [line, setLine] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [storage, setStorage] = useState<KeyStorage | undefined>();
  /** Try again after an error (a hardware key that failed is not replaced by a software one). */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    appPublicKeyLine().then(
      (l) => live && setLine(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    appKeyInfo().then(
      (k) => live && setStorage(k.storage),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const copy = async (): Promise<void> => {
    if (!line) return;
    await Clipboard.setStringAsync(line);
    setCopied(true);
  };
  const settings = useOutputSettings();
  /** The web app where the browser offers passkeys: the switch makes one. */
  const web = passkeysAvailable();
  /** The phone has a hardware keystore and the switch is on: each use should ask for the user. */
  const hardwareGated = !web && HardwareKey !== null && settings.keyNeedsUser;
  const gatedButSoftware = hardwareGated && storage === 'secure-store';
  /** The switch was flipped: the new value, until the user confirms making a new key. */
  const [changing, setChanging] = useState<boolean | undefined>();
  const [newKey, setNewKey] = useState(false);
  const changeKey = async (on: boolean): Promise<void> => {
    setChanging(undefined);
    try {
      const k = await setKeyNeedsUser(on);
      setStorage(k.storage);
      setLine(await appPublicKeyLine());
      setError(undefined);
      setCopied(false);
      setNewKey(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const [replacing, setReplacing] = useState(false);
  const replaceKey = async (): Promise<void> => {
    setReplacing(false);
    try {
      const k = await replaceWithUnexportableKey();
      setStorage(k.storage);
      setLine(await appPublicKeyLine());
      setError(undefined);
      setCopied(false);
      setNewKey(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.appKeyTitle}</Text>
      <Text style={styles.help}>{t.appKeyHelp}</Text>
      {error ? (
        <>
          <Text testID="app-key-error" role="alert" style={styles.error}>
            {t.appKeyFailed(error)}
          </Text>
          <Pressable
            testID="app-key-retry"
            accessibilityRole="button"
            onPress={() => {
              setError(undefined);
              setAttempt((n) => n + 1);
            }}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t.appKeyRetry}</Text>
          </Pressable>
        </>
      ) : (
        <Text testID="app-public-key" style={styles.key} selectable>
          {line ?? t.appKeyLoading}
        </Text>
      )}
      {storage ? (
        <Text testID="app-key-storage" style={styles.help}>
          {t.appKeyStorage[storage]}
        </Text>
      ) : null}
      {/* A software key made by an earlier version when the hardware failed: the switch is on, but
          nothing asks. Off and on again makes a hardware key. */}
      {gatedButSoftware ? (
        <Text testID="key-not-enforced" role="alert" style={styles.error}>
          {t.keyNotEnforced}
        </Text>
      ) : null}
      {/* Only a key in the phone's keystore can require the user (the hardware enforces it); on
          the web, a passkey does. A failed hardware key with the switch on keeps the switch, to turn it off. */}
      {storage === 'hardware' || storage === 'keystore' || web || gatedButSoftware || (error && hardwareGated) ? (
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>{web ? t.usePasskey : t.keyNeedsUser}</Text>
            <Points items={web ? t.usePasskeyPoints : t.keyNeedsUserPoints} textStyle={styles.help} />
          </View>
          <Toggle
            testID="setting-keyNeedsUser"
            accessibilityLabel={web ? t.usePasskey : t.keyNeedsUser}
            value={changing ?? settings.keyNeedsUser}
            onValueChange={(on) => setChanging(on)}
          />
        </View>
      ) : null}
      {changing !== undefined ? (
        <View testID="key-change-confirm">
          <Text style={[styles.error, styles.strong]} role="heading">
            {t.keyChangeTitle}
          </Text>
          <Points items={web ? t.passkeyChangePoints : t.keyChangePoints} textStyle={[styles.error, styles.point]} />
          <View style={styles.chips}>
            <Pressable testID="key-change-go" accessibilityRole="button" onPress={() => void changeKey(changing)} style={styles.button}>
              <Text style={styles.buttonText}>{t.keyChangeGo}</Text>
            </Pressable>
            <Pressable testID="key-change-cancel" accessibilityRole="button" onPress={() => setChanging(undefined)} style={styles.button}>
              <Text style={styles.buttonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {/* Web, a key from an earlier version (readable in the browser's storage): replaced only when the user says so. */}
      {storage === 'browser' && webKeysAvailable() && !replacing ? (
        <View testID="key-replace-offer">
          <Points items={t.browserKeyPoints} textStyle={styles.help} />
          <Pressable testID="key-replace" accessibilityRole="button" onPress={() => setReplacing(true)} style={styles.button}>
            <Text style={styles.buttonText}>{t.browserKeyReplace}</Text>
          </Pressable>
        </View>
      ) : null}
      {replacing ? (
        <View testID="key-replace-confirm">
          <Text style={[styles.error, styles.strong]} role="heading">
            {t.keyChangeTitle}
          </Text>
          <Points items={t.browserKeyChangePoints} textStyle={[styles.error, styles.point]} />
          <View style={styles.chips}>
            <Pressable testID="key-replace-go" accessibilityRole="button" onPress={() => void replaceKey()} style={styles.button}>
              <Text style={styles.buttonText}>{t.keyChangeGo}</Text>
            </Pressable>
            <Pressable testID="key-replace-cancel" accessibilityRole="button" onPress={() => setReplacing(false)} style={styles.button}>
              <Text style={styles.buttonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {newKey ? (
        <Text testID="key-changed" role="alert" style={styles.help}>
          {t.keyChanged}
        </Text>
      ) : null}
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

/**
 * Signing runbooks with this app's key: the name signatures carry, and the key's line for the
 * servers' allowed_signers (md-runbook-gate checks signatures against it).
 */
function SigningSection() {
  const styles = useStyles();
  const colors = usePalette();
  // The saved name until one is typed (settings may load after the screen opens).
  const saved = useSignerName();
  const [typed, setName] = useState<string | undefined>();
  const name = typed ?? saved;
  const [line, setLine] = useState<string | undefined>();
  const [runnersLine, setRunnersLine] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [copiedRunners, setCopiedRunners] = useState(false);
  // Only a name allowed_signers reads as written gets a line (and is saved).
  const principal = SIGNER_NAME_RE.test(name.trim()) ? name.trim() : undefined;
  useEffect(() => {
    let live = true;
    if (principal === undefined) return;
    // A failure (no key yet) leaves the line out; the app key section above says why.
    Promise.resolve()
      .then(() => appAllowedSignersLine(principal))
      .then(
        (l) => live && setLine(l),
        () => live && setLine(undefined),
      );
    // The same key, for the run reports it signs (namespace md-runbook-run).
    Promise.resolve()
      .then(() => appAllowedRunnersLine(principal))
      .then(
        (l) => live && setRunnersLine(l),
        () => live && setRunnersLine(undefined),
      );
    return () => {
      live = false;
    };
  }, [principal]);
  // A line made for an earlier, valid name isn't shown for an invalid one.
  const shown = principal === undefined ? undefined : line;
  const shownRunners = principal === undefined ? undefined : runnersLine;
  const copy = async (): Promise<void> => {
    if (!shown) return;
    await Clipboard.setStringAsync(shown);
    setCopied(true);
  };
  const copyRunners = async (): Promise<void> => {
    if (!shownRunners) return;
    await Clipboard.setStringAsync(shownRunners);
    setCopiedRunners(true);
  };
  return (
    <View testID="signing" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.signingTitle}</Text>
      <Points items={t.signingPoints} textStyle={styles.help} />
      <Text style={styles.label}>{t.signerName}</Text>
      <TextInput
        testID="signer-name"
        style={styles.input}
        value={name}
        onChangeText={(v) => {
          setName(v);
          setCopied(false);
          setCopiedRunners(false);
        }}
        onEndEditing={() => principal !== undefined && setSignerName(principal)}
        onBlur={() => principal !== undefined && setSignerName(principal)}
        placeholder={t.signerPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {name.trim() !== '' && principal === undefined ? (
        <Text testID="signer-name-rule" style={styles.error}>
          {t.signerNameRule}
        </Text>
      ) : null}
      <Text style={styles.help}>{t.allowedSignersHelp}</Text>
      <Text testID="allowed-signers-line" style={styles.key} selectable>
        {shown ?? (principal === undefined ? t.signerNameFirst : t.appKeyLoading)}
      </Text>
      <Pressable
        testID="copy-allowed-signers"
        accessibilityRole="button"
        disabled={!shown}
        onPress={() => void copy()}
        style={[styles.button, !shown && styles.disabled]}
      >
        <Text style={styles.buttonText}>{copied ? t.copied : t.copy}</Text>
      </Pressable>
      <Text style={styles.help}>{t.allowedRunnersHelp}</Text>
      <Text testID="allowed-runners-line" style={styles.key} selectable>
        {shownRunners ?? (principal === undefined ? t.signerNameFirst : t.appKeyLoading)}
      </Text>
      <Pressable
        testID="copy-allowed-runners"
        accessibilityRole="button"
        disabled={!shownRunners}
        onPress={() => void copyRunners()}
        style={[styles.button, !shownRunners && styles.disabled]}
      >
        <Text style={styles.buttonText}>{copiedRunners ? t.copied : t.copy}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Run reports (report-runs: in a runbook): the addresses allowed without asking, and the answers
 * given so far (each can be forgotten). Which signed runbooks may require reporting is decided by
 * the one list of trusted signers (TrustedSignersSection).
 */
function ReportsSection() {
  const styles = useStyles();
  const colors = usePalette();
  const s = useOutputSettings();
  const consents = useConsents();
  useEffect(() => void loadConsents(), []);
  // What is typed, until it is saved (on leaving the field).
  const [addresses, setAddresses] = useState<string | undefined>();
  return (
    <View testID="reports-setting" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.reportsTitle}</Text>
      <Points items={t.reportsPoints} textStyle={styles.help} />
      <Text style={styles.label}>{t.reportAddresses}</Text>
      <Text style={styles.help}>{t.reportAddressesHelp}</Text>
      <TextInput
        testID="report-addresses"
        style={styles.input}
        value={addresses ?? s.reportAddresses.join('\n')}
        onChangeText={setAddresses}
        onEndEditing={() => addresses !== undefined && setReportAddresses(addresses)}
        onBlur={() => addresses !== undefined && setReportAddresses(addresses)}
        placeholder={t.reportAddressesPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <Points testID="reports-trust-help" items={t.reportsTrustPoints} textStyle={styles.help} />
      {Object.keys(consents).length > 0 ? <Text style={styles.label}>{t.reportAnswers}</Text> : null}
      {Object.entries(consents).map(([key, answer]) => (
        <View key={key} style={styles.secretRow}>
          <Text style={[styles.help, styles.switchText]}>{answer === 'allow' ? t.reportAnswerAllow(key) : t.reportAnswerNever(key)}</Text>
          <Pressable testID={`forget-report-${key}`} accessibilityRole="button" onPress={() => void forgetConsent(key)}>
            <Text style={styles.link}>{t.forgetReportAnswer}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** The stored `${secret:NAME}` names (never their values), each with Forget. */
/** How many earlier runs each cell keeps in the file (the extension's mdRunbook.output.historySize). */
function HistorySection() {
  const styles = useStyles();
  const size = useHistorySize();
  return (
    <View testID="history-setting" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.historyTitle}</Text>
      <Text style={styles.help}>{t.historyHelp}</Text>
      <View style={styles.chips}>
        {HISTORY_SIZES.map((n) => (
          <Pressable
            key={n}
            testID={`history-${n}`}
            accessibilityRole="button"
            accessibilityState={{ selected: n === size }}
            onPress={() => setHistorySize(n)}
            style={[styles.chip, n === size && styles.chipOn]}
          >
            <Text style={[styles.chipText, n === size && styles.chipTextOn]}>{t.historyKeep(n)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** How output is coloured (the extension's mdRunbook.output.colorLevels, stderrInRed, forceColor). */
function ColorSection() {
  const styles = useStyles();
  const s = useOutputSettings();
  const rows = [
    { key: 'colorLevels', label: t.colorLevels, help: t.colorLevelsHelp },
    { key: 'stderrInRed', label: t.stderrInRed, help: t.stderrInRedHelp },
    { key: 'forceColor', label: t.forceColor, help: t.forceColorHelp },
    { key: 'cloudViews', label: t.cloudViews, help: t.cloudViewsHelp },
  ] as const;
  return (
    <View testID="color-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.colorsTitle}</Text>
      {rows.map((r) => (
        <View key={r.key} style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>{r.label}</Text>
            <Text style={styles.help}>{r.help}</Text>
          </View>
          <Toggle
            testID={`setting-${r.key}`}
            accessibilityLabel={r.label}
            value={s[r.key]}
            onValueChange={(on) => setOutputSetting(r.key, on)}
          />
        </View>
      ))}
    </View>
  );
}

/** Runbook links: whether only signed or pinned ones open (off: the others open with a warning). */
function LinksSection() {
  const styles = useStyles();
  const s = useOutputSettings();
  return (
    <View testID="link-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.linksTitle}</Text>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.signedLinksOnly}</Text>
          <Points items={t.signedLinksOnlyPoints} textStyle={styles.help} />
        </View>
        <Toggle
          testID="setting-signedLinksOnly"
          accessibilityLabel={t.signedLinksOnly}
          value={s.signedLinksOnly}
          onValueChange={(on) => setOutputSetting('signedLinksOnly', on)}
        />
      </View>
    </View>
  );
}

/**
 * Confirmation of risky cells: whether a runbook's `no-confirm` counts (the extension's
 * allowNoConfirmOption); and whether Run all opens the launch form first.
 */
function SafetySection() {
  const styles = useStyles();
  const s = useOutputSettings();
  return (
    <View testID="safety-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.safetyTitle}</Text>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.allowNoConfirm}</Text>
          <Points items={t.allowNoConfirmPoints} textStyle={styles.help} />
        </View>
        <Toggle
          testID="setting-allowNoConfirm"
          accessibilityLabel={t.allowNoConfirm}
          value={s.allowNoConfirm}
          onValueChange={(on) => setOutputSetting('allowNoConfirm', on)}
        />
      </View>
      {/* The launch form before Run all (the extension's mdRunbook.execution.launchForm). */}
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.launchForm}</Text>
          <Points items={t.launchFormPoints} textStyle={styles.help} />
        </View>
        <Toggle
          testID="setting-launchForm"
          accessibilityLabel={t.launchForm}
          value={s.launchForm}
          onValueChange={(on) => setOutputSetting('launchForm', on)}
        />
      </View>
    </View>
  );
}

/** Notifications about runs while the app is away (offered at the first Run all; here on or off). */
function NotificationsSection() {
  const styles = useStyles();
  const s = useOutputSettings();
  /** Turned on, and the system said no: where to allow them. */
  const [blocked, setBlocked] = useState(false);
  if (!notificationsSupported()) return null;
  const web = Platform.OS === 'web';
  return (
    <View testID="notify-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.notifyTitle}</Text>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.notifyRuns}</Text>
          {web ? <Text style={styles.help}>{t.notifyRunsHelpWeb}</Text> : <Points items={t.notifyRunsPoints} textStyle={styles.help} />}
        </View>
        <Toggle
          testID="setting-notifyRuns"
          accessibilityLabel={t.notifyRuns}
          value={s.notifyRuns === true}
          onValueChange={(on) => {
            setBlocked(false);
            if (!on) return setNotifyRuns(false);
            void turnOnNotifications().then((ok) => setBlocked(!ok));
          }}
        />
      </View>
      {blocked ? (
        <View style={styles.switchText}>
          <Text testID="notify-blocked" style={styles.help}>
            {web ? t.notifyBlockedWeb : t.notifyBlocked}
          </Text>
          {web ? null : (
            <Pressable testID="notify-open-settings" accessibilityRole="button" onPress={() => void Linking.openSettings()}>
              <Text style={styles.link}>{t.openSettings}</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

function SecretsSection() {
  const styles = useStyles();
  const names = useSecretNames();
  /** The secret whose new value is being typed, and that value. */
  const [editing, setEditing] = useState<{ name: string; value: string } | undefined>();
  useEffect(() => {
    void loadSecretNames();
  }, []);
  const save = async (): Promise<void> => {
    if (!editing || editing.value === '') return;
    await storeSecret(editing.name, editing.value);
    setEditing(undefined);
  };
  /** A new secret being typed (before any cell asks for it). */
  const [adding, setAdding] = useState<{ name: string; value: string } | undefined>();
  const addable = adding !== undefined && VAR_NAME_RE.test(adding.name) && adding.value !== '';
  const add = async (): Promise<void> => {
    if (!adding || !addable) return;
    await storeSecret(adding.name, adding.value);
    setAdding(undefined);
  };
  return (
    <View testID="secrets" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.secretsTitle}</Text>
      <Text style={styles.help}>{names.length > 0 ? t.secretsHelp : t.secretsNone}</Text>
      {names.map((n) => (
        <View key={n}>
          <View style={styles.secretRow}>
            <Text style={styles.secretName}>{n}</Text>
            <View style={styles.secretActions}>
              <Pressable testID={`change-secret-${n}`} accessibilityRole="button" onPress={() => setEditing({ name: n, value: '' })}>
                <Text style={styles.link}>{t.changeSecret}</Text>
              </Pressable>
              <Pressable testID={`forget-secret-${n}`} accessibilityRole="button" onPress={() => void forgetSecret(n)}>
                <Text style={styles.link}>{t.forgetSecret}</Text>
              </Pressable>
            </View>
          </View>
          {editing?.name === n ? (
            <View style={styles.secretEdit}>
              <TextInput
                testID={`secret-value-${n}`}
                accessibilityLabel={t.newSecretValue(n)}
                style={[styles.input, styles.secretInput]}
                value={editing.value}
                onChangeText={(value) => setEditing({ name: n, value })}
                placeholder={t.newSecretValue(n)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                testID={`save-secret-${n}`}
                accessibilityRole="button"
                disabled={editing.value === ''}
                onPress={() => void save()}
                style={[styles.button, editing.value === '' && styles.disabled]}
              >
                <Text style={styles.buttonText}>{t.save}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
      {adding ? (
        <View testID="add-secret-form">
          <Text style={styles.label}>{t.secretName}</Text>
          <TextInput
            testID="new-secret-name"
            accessibilityLabel={t.secretName}
            style={styles.input}
            value={adding.name}
            onChangeText={(name) => setAdding({ ...adding, name })}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {adding.name !== '' && !VAR_NAME_RE.test(adding.name) ? <Text style={styles.error}>{t.badSecretName}</Text> : null}
          <Text style={styles.label}>{t.secretValue}</Text>
          <TextInput
            testID="new-secret-value"
            accessibilityLabel={t.secretValue}
            style={styles.input}
            value={adding.value}
            onChangeText={(value) => setAdding({ ...adding, value })}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            testID="save-new-secret"
            accessibilityRole="button"
            disabled={!addable}
            onPress={() => void add()}
            style={[styles.button, !addable && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.save}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable testID="add-secret" accessibilityRole="button" onPress={() => setAdding({ name: '', value: '' })} style={styles.button}>
          <Text style={styles.buttonText}>{t.addSecret}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Relay (web): its address (by default this server's relay, when the page's own origin answers as
 * one) and token; Pair a device shows them as a code for another device's web app, and Pair with
 * another device scans such a code (pairing/payload.ts).
 */
function RelaySection() {
  const styles = useStyles();
  const colors = usePalette();
  const [url, setUrl] = useState('');
  /** This server's relay, when the page's origin is one. */
  const [own, setOwn] = useState<string | undefined>();
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [tokenProblem, setTokenProblem] = useState<string | undefined>();
  const [pairing, setPairing] = useState(false);
  const [noCamera, setNoCamera] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([getRelayUrlSetting(), getRelayToken(), sameOriginRelay()]).then(([set, tok, here]) => {
      if (!live) return;
      setOwn(here);
      // The address the user set wins; none set: this server's relay.
      setUrl((typed) => typed || set || here || '');
      setToken((typed) => typed || tok);
    });
    return () => {
      live = false;
    };
  }, []);
  const urlProblem = url.trim() === '' ? undefined : relayUrlProblem(url);
  const save = async (): Promise<void> => {
    // Refused here rather than as a failed connection later: the browser can't send such a token.
    const bad = badTokenCharacter(token);
    setTokenProblem(bad === undefined ? undefined : t.relayTokenInvalid(bad));
    if (bad !== undefined || urlProblem) return;
    await setRelaySettings({ url, token });
    setSaved(true);
  };
  return (
    <View testID="relay-settings" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.relayTitle}</Text>
      <Text style={styles.help}>{t.relayHelp}</Text>
      <Text style={styles.label}>{t.relayUrl}</Text>
      <TextInput
        testID="relay-url"
        accessibilityLabel={t.relayUrl}
        style={styles.input}
        value={url}
        onChangeText={(v) => {
          setUrl(v);
          setSaved(false);
        }}
        placeholder={own ?? t.relayUrlPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {own && url.trim().replace(/\/+$/, '') === own ? (
        <Text testID="relay-same-origin" style={styles.help}>
          {t.relaySameOrigin(own)}
        </Text>
      ) : null}
      {urlProblem ? (
        <Text testID="relay-url-problem" style={styles.error}>
          {t.relayUrlProblem[urlProblem]}
        </Text>
      ) : null}
      <Text style={styles.label}>{t.relayToken}</Text>
      <TextInput
        testID="relay-token"
        accessibilityLabel={t.relayToken}
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
      {tokenProblem ? (
        <Text testID="relay-token-problem" role="alert" style={styles.error}>
          {tokenProblem}
        </Text>
      ) : null}
      <View style={styles.chips}>
        <Pressable
          testID="relay-save"
          accessibilityRole="button"
          disabled={urlProblem !== undefined}
          onPress={() => void save()}
          style={[styles.button, urlProblem !== undefined && styles.disabled]}
        >
          <Text style={styles.buttonText}>{saved ? t.relaySaved : t.save}</Text>
        </Pressable>
        <Pressable
          testID="relay-pair-device"
          accessibilityRole="button"
          aria-expanded={pairing}
          onPress={() => setPairing(!pairing)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t.pairDevice}</Text>
        </Pressable>
        <Pressable
          testID="relay-pair-with"
          accessibilityRole="button"
          onPress={() => {
            if (cameraUsable()) router.push('/scan');
            else setNoCamera(true);
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t.pairWithDevice}</Text>
        </Pressable>
      </View>
      <Text style={styles.help}>{t.pairWithDeviceHelp}</Text>
      {noCamera ? (
        <Text testID="relay-no-camera" role="alert" style={styles.error}>
          {t.pairNoCamera}
        </Text>
      ) : null}
      {/* Remounted after a save: it hands on what is saved. */}
      {pairing ? <PairDeviceCard key={saved ? 'saved' : 'before'} onClose={() => setPairing(false)} /> : null}
    </View>
  );
}

/**
 * Public address of this web app (web): what share links, QR codes and pairing links start with
 * (settings/publicAddress.ts), when other devices reach this web app at another address than this
 * page's (a tunnel, a reverse proxy). Empty: the server's MD_RUNBOOK_PUBLIC_URL, else this page's.
 */
function PublicAddressSection() {
  const styles = useStyles();
  const colors = usePalette();
  const saved = usePublicUrlSetting();
  useRuntimeConfig();
  const [draft, setDraft] = useState<string | undefined>();
  const value = draft ?? saved;
  const problem = value.trim() === '' ? undefined : publicUrlProblem(value);
  const now = publicBaseOf();
  return (
    <View testID="public-address" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.publicUrlTitle}</Text>
      <Points items={t.publicUrlPoints} textStyle={styles.help} />
      <TextInput
        testID="public-url"
        accessibilityLabel={t.publicUrlTitle}
        style={styles.input}
        value={value}
        onChangeText={setDraft}
        placeholder={runtimeConfig().publicUrl ?? t.publicUrlPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {problem ? (
        <Text testID="public-url-problem" style={styles.error}>
          {t.publicUrlProblem[problem]}
        </Text>
      ) : null}
      {now ? (
        <Text testID="public-url-now" style={styles.help}>
          {t.publicUrlNow(now.base, now.source)}
        </Text>
      ) : null}
      <View style={styles.chips}>
        {draft !== undefined && draft.trim() !== saved ? (
          <Pressable
            testID="public-url-save"
            accessibilityRole="button"
            disabled={problem !== undefined}
            onPress={() => {
              setPublicUrl(draft.trim() === '' ? '' : normalizePublicUrl(draft));
              setDraft(undefined);
            }}
            style={[styles.button, problem !== undefined && styles.disabled]}
          >
            <Text style={styles.buttonText}>{t.save}</Text>
          </Pressable>
        ) : null}
        {saved ? (
          <Pressable
            testID="public-url-remove"
            accessibilityRole="button"
            onPress={() => {
              setPublicUrl('');
              setDraft(undefined);
            }}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{t.publicUrlRemove}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// The start screen's look: a heading over the hosts' card, then one card per setting.
const useStyles = themedStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  groupTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  groupHelp: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 8, marginHorizontal: 4 },
  button: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.accent,
    marginTop: 12,
  },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.onAccent },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  badge: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  rowText: { flex: 1 },
  addText: { fontSize: 16, fontWeight: '500', color: colors.link },
  title: { fontSize: 16, fontWeight: '500', color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
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
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  switchText: { flex: 1 },
  switchLabel: { fontSize: 15, color: colors.text },
  key: {
    fontFamily: mono,
    fontSize: 12,
    color: colors.text,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
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
  error: { fontSize: 13, color: colors.error, marginTop: 8 },
  strong: { fontWeight: '600' },
  point: { marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  groupChips: { marginTop: 0, marginBottom: 10 },
  qrBox: { alignItems: 'center', marginTop: 12 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: colors.onAccent },
  secretRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  secretName: { fontFamily: mono, fontSize: 14, color: colors.text },
  secretActions: { flexDirection: 'row', gap: 16 },
  secretEdit: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  secretInput: { flex: 1, marginTop: 0 },
  link: { fontSize: 15, color: colors.link },
}));

/** Share hosts: the listed ones (a group when one is picked) as a file or a QR code, and Import… */
function ShareHostsSection({ hosts }: { hosts: readonly Host[] }) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const [withKeys, setWithKeys] = useState(false);
  const [qr, setQr] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** The web: the relay's address, as other devices reach it (never its token). */
  const [relayUrl, setRelayUrl] = useState<string | undefined>();
  const [withRelay, setWithRelay] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let live = true;
    void Promise.all([getRelayUrlSetting(), sameOriginRelay()]).then(([set, here]) => {
      const url = set || here;
      if (live && url) setRelayUrl(toPublicRelayUrl(url));
    });
    return () => {
      live = false;
    };
  }, []);
  const relay = withRelay ? relayUrl : undefined;
  const matrix = qr ? qrMatrix(hostsLink(hosts, withKeys, relay)) : undefined;
  return (
    <View testID="share-hosts" style={styles.section}>
      <Text style={styles.sectionTitle}>{t.hostsShareTitle}</Text>
      <Points items={t.hostsSharePoints} textStyle={styles.help} />
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t.hostsWithKeys}</Text>
        </View>
        <Toggle testID="share-hosts-keys" accessibilityLabel={t.hostsWithKeys} value={withKeys} onValueChange={setWithKeys} />
      </View>
      {relayUrl ? (
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>{t.hostsWithRelay(relayUrl)}</Text>
          </View>
          <Toggle
            testID="share-hosts-relay"
            accessibilityLabel={t.hostsWithRelay(relayUrl)}
            value={withRelay}
            onValueChange={setWithRelay}
          />
        </View>
      ) : null}
      <View style={styles.chips}>
        <Pressable
          testID="share-hosts-file"
          accessibilityRole="button"
          onPress={() =>
            void shareHostsFile(hostsJson(hosts, withKeys, relay)).catch((e: unknown) =>
              setError(e instanceof Error ? e.message : String(e)),
            )
          }
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t.hostsExportFile}</Text>
        </Pressable>
        <Pressable testID="share-hosts-qr" accessibilityRole="button" onPress={() => setQr(!qr)} style={styles.button}>
          <Text style={styles.buttonText}>{t.hostsShowQr}</Text>
        </Pressable>
        <Link href={{ pathname: '/hosts/import', params: {} }} asChild>
          <Pressable testID="hosts-import-open" accessibilityRole="button" style={styles.button}>
            <Text style={styles.buttonText}>{t.hostsImport}</Text>
          </Pressable>
        </Link>
      </View>
      {qr ? (
        matrix ? (
          <View style={styles.qrBox}>
            <QrView testID="share-hosts-code" matrix={matrix} size={Math.min(width - 96, 300)} />
          </View>
        ) : (
          <Text testID="share-hosts-too-many" style={styles.error}>
            {t.hostsTooMany}
          </Text>
        )
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

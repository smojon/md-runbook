/**
 * Publish to Library… and Remove from Library… (⋯ More → Share, and a Team runbooks row's ⋯), as
 * VS Code's. Publish takes a runbook signed as a whole and unchanged since (else it offers Sign
 * Runbook); its path in the library ends with the signed name. Remove is its own confirmation:
 * what it does, then Remove. The upload token is asked for once per server and kept in the app's
 * secure storage; a refused token is asked for again.
 */
import { router } from 'expo-router';
import { ReactNode, useEffect, useState } from 'react';
import { signedStatus } from '@md-runbook/core/signing';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { t } from '../i18n';
import { refreshLibrary } from '../runbooks/library';
import {
  PublishFetch,
  TOKEN_RE,
  cleanLibraryPath,
  defaultPath,
  libraryServer,
  pathProblem,
  publishCheck,
  publishedText,
  refusalText,
  rememberPublished,
  sendToLibrary,
  serverHost,
  storeToken,
  storedToken,
} from '../runbooks/libraryPublish';
import type { Runbook } from '../runbooks/store';
import { themedStyles, usePalette } from '../theme';
import { Grabber } from './Grabber';
import { Points } from './Points';

export type PublishRequest = { mode: 'publish'; runbook: Runbook } | { mode: 'remove'; runbook?: Runbook; path?: string };

interface Result {
  ok: boolean;
  title: string;
  points: readonly string[];
}

export function LibraryPublishSheet({
  request,
  onClose,
  onSign,
  onDone,
  fetchFn,
}: {
  request: PublishRequest | undefined;
  onClose(): void;
  /** The runbook isn't signed as the library needs: Sign Runbook (absent: open the runbook to sign it there). */
  onSign?(): void;
  /** Published or removed: what the server said. */
  onDone?(message: string): void;
  fetchFn?: PublishFetch;
}) {
  return (
    <Modal visible={request !== undefined} animationType="slide" transparent onRequestClose={onClose}>
      {request ? <SheetBody request={request} onClose={onClose} onSign={onSign} onDone={onDone} fetchFn={fetchFn} /> : null}
    </Modal>
  );
}

function SheetBody({
  request,
  onClose,
  onSign,
  onDone,
  fetchFn,
}: {
  request: PublishRequest;
  onClose(): void;
  onSign?(): void;
  onDone?(message: string): void;
  fetchFn?: PublishFetch;
}) {
  const styles = useStyles();
  const colors = usePalette();
  const server = libraryServer();
  const runbook = request.runbook;
  const check = request.mode === 'publish' ? publishCheck(request.runbook.text) : undefined;
  const name = check?.ok ? check.manifest.name : undefined;
  const [path, setPath] = useState<string | undefined>(request.mode === 'remove' ? request.path : undefined);
  /** The token field: shown when none is stored, or the server refused the stored one. */
  const [askToken, setAskToken] = useState<boolean | undefined>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();
  useEffect(() => {
    if (!server) return;
    let live = true;
    void storedToken(server).then((v) => {
      if (live) setAskToken(!v);
    });
    if (path === undefined) {
      // Remove: the runbook's signed name, readable or not as the library would take it.
      const signedName = name ?? (runbook ? signedStatus(runbook.text)?.manifest.name : undefined);
      void defaultPath(runbook ?? { id: '' }, server, signedName).then((p) => {
        if (live) setPath((now) => now ?? p);
      });
    }
    return () => {
      live = false;
    };
    // Once for the sheet: its server and runbook don't change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (
    <Pressable testID="publish-cancel" accessibilityRole="button" onPress={onClose} style={styles.secondary}>
      <Text style={styles.secondaryText}>{result?.ok ? t.close : t.cancel}</Text>
    </Pressable>
  );
  const frame = (body: ReactNode) => (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.close} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View testID="publish-sheet" style={styles.sheet}>
          <Grabber onClose={onClose} />
          <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </>
  );

  // Not signed as the library needs: say why, offer Sign Runbook.
  if (check && !check.ok) {
    const why = t.publishCheck[check.why];
    return frame(
      <View testID="publish-not-signed">
        <Text style={styles.title} role="heading">
          {why.title}
        </Text>
        <Points items={why.points} textStyle={styles.body} />
        <View style={styles.buttons}>
          {close}
          <Pressable
            testID="publish-sign"
            accessibilityRole="button"
            onPress={() => {
              onClose();
              if (onSign) onSign();
              else if (runbook) router.push({ pathname: '/runbook/[id]', params: { id: runbook.id } });
            }}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{t.actions.signRunbook[0]}</Text>
          </Pressable>
        </View>
      </View>,
    );
  }
  if (!server) {
    return frame(
      <View testID="publish-no-server">
        <Text style={styles.title} role="heading">
          {t.publishNoServer}
        </Text>
        <Points items={t.publishNoServerPoints} textStyle={styles.body} />
        <View style={styles.buttons}>
          {close}
          <Pressable
            testID="publish-settings"
            accessibilityRole="button"
            onPress={() => {
              onClose();
              router.push('/hosts');
            }}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{t.actions.hosts[0]}</Text>
          </Pressable>
        </View>
      </View>,
    );
  }

  const host = serverHost(server);
  const publishing = request.mode === 'publish';
  const where = cleanLibraryPath(path ?? '');
  const problem = path === undefined || path.trim() === '' ? undefined : pathProblem(where, name);
  const tokenOk = !askToken || TOKEN_RE.test(token.trim());
  const ready = path !== undefined && where !== '' && problem === undefined && askToken !== undefined && tokenOk && !busy;

  const send = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setResult(undefined);
    try {
      if (askToken) await storeToken(server, token);
      const bearer = askToken ? token.trim() : ((await storedToken(server)) ?? '');
      const r = await sendToLibrary({
        method: publishing ? 'POST' : 'DELETE',
        server,
        path: where,
        token: bearer,
        ...(publishing ? { text: request.runbook.text } : {}),
        ...(fetchFn ? { fetchFn } : {}),
      });
      if (r.kind === 'unreachable') return setResult({ ok: false, title: t.publishUnreachable(host), points: [r.why] });
      const ok = publishing ? r.status === 200 || r.status === 201 : r.status === 200;
      if (ok) {
        const text = publishing ? publishedText(where, r.answer) : t.removed(where, r.answer.version);
        if (publishing && runbook) await rememberPublished(runbook.id, where);
        void refreshLibrary({ force: true }).catch(() => undefined);
        setResult({ ok: true, title: text, points: [] });
        onDone?.(text);
        return;
      }
      // The stored token was refused: ask for another one.
      if (r.status === 401) {
        setToken('');
        setAskToken(true);
      }
      setResult({ ok: false, ...refusalText(publishing ? 'POST' : 'DELETE', where, r.status, r.answer) });
    } catch (e) {
      setResult({ ok: false, title: t.publishUnreachable(host), points: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setBusy(false);
    }
  };

  return frame(
    <View testID={publishing ? 'publish-form' : 'remove-form'}>
      <Text style={styles.title} role="heading">
        {check?.ok ? t.publishTitle(check.manifest.name, check.manifest.version, host) : t.removeTitle(host)}
      </Text>
      <Points items={publishing ? t.publishPoints : t.removePoints} textStyle={styles.body} />
      <Text style={styles.label}>{t.publishPath}</Text>
      <TextInput
        testID="publish-path"
        accessibilityLabel={t.publishPath}
        value={path ?? ''}
        onChangeText={(v) => {
          setPath(v);
          setResult(undefined);
        }}
        placeholder={name ? `${name}.md` : t.publishPathPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      {problem ? (
        <Text testID="publish-path-problem" style={styles.error}>
          {problem}
        </Text>
      ) : null}
      {askToken ? (
        <>
          <Text style={styles.label}>{t.publishToken(host)}</Text>
          <TextInput
            testID="publish-token"
            accessibilityLabel={t.publishToken(host)}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Points items={[t.publishTokenFrom, Platform.OS === 'web' ? t.tokenKeptWeb : t.tokenKeptDevice]} textStyle={styles.help} />
          {token.trim() !== '' && !tokenOk ? <Text style={styles.error}>{t.publishTokenShape}</Text> : null}
        </>
      ) : null}
      {result ? (
        <View testID="publish-result" style={styles.result}>
          <Text role={result.ok ? 'status' : 'alert'} style={result.ok ? styles.ok : styles.error}>
            {result.title}
          </Text>
          {result.points.length ? <Points items={result.points} textStyle={styles.help} /> : null}
        </View>
      ) : null}
      <View style={styles.buttons}>
        {close}
        {result?.ok ? null : (
          <Pressable
            testID={publishing ? 'publish-go' : 'remove-go'}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready }}
            disabled={!ready}
            onPress={() => void send()}
            style={[publishing ? styles.primary : styles.danger, !ready && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.primaryText}>{publishing ? t.publishGo : t.removeGo}</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>,
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: c.scrim },
  sheet: {
    maxHeight: '85%',
    backgroundColor: c.sheet,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    paddingBottom: 28,
  },
  title: { fontSize: 17, fontWeight: '600', color: c.text, marginBottom: 6 },
  body: { fontSize: 14, color: c.text, lineHeight: 20 },
  help: { fontSize: 13, color: c.muted, lineHeight: 18 },
  label: { fontSize: 13, color: c.muted, marginTop: 14, marginBottom: 4 },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: c.text,
    backgroundColor: c.background,
    marginBottom: 4,
  },
  error: { fontSize: 13, color: c.error, marginTop: 4 },
  ok: { fontSize: 14, color: c.ok },
  result: { marginTop: 12, gap: 4 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 16 },
  primary: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accent,
  },
  danger: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.error,
  },
  primaryText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  secondaryText: { fontSize: 15, color: c.link },
  disabled: { opacity: 0.5 },
}));

/**
 * Scan a code: the camera reads a runbook QR code (a label on a machine, a code a colleague shows)
 * and opens its runbook link (core/runbookLink.ts) as any link does: nothing runs, the runbook
 * says whether it is signed, and its host and parameters are filled in.
 */
import { parseRunbookLink } from '@md-runbook/core/runbookLink';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { openRunbookLink } from '../runbooks/openLink';
import { themedStyles } from '../theme';

export function ScanScreen() {
  const styles = useStyles();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | undefined>();
  /** A code is being opened: the camera keeps reporting it many times a second. */
  const busy = useRef(false);

  const onScanned = (result: BarcodeScanningResult): void => {
    if (busy.current) return;
    busy.current = true;
    // A colleague's hosts (Share hosts → Show as a QR code): to the import screen, which asks first.
    const hosts = /^mdrunbook:\/\/hosts\/import\?(?:.*&)?h=([A-Za-z0-9_-]+)/.exec(result.data)?.[1];
    if (hosts) return router.replace({ pathname: '/hosts/import', params: { h: hosts } });
    const parsed = parseRunbookLink(result.data);
    if (!parsed.ok) {
      setMessage(t.scanNotRunbook);
      // Let the next code in, after the message had a moment.
      setTimeout(() => (busy.current = false), 1500);
      return;
    }
    setMessage(t.linkOpening);
    void openRunbookLink(result.data).then((r) => {
      if (r.kind === 'error') {
        setMessage(r.message);
        setTimeout(() => (busy.current = false), 2500);
      } else router.replace({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
    });
  };

  if (!permission) return <View style={styles.screen} />;
  if (!permission.granted) {
    const blocked = !permission.canAskAgain && Platform.OS !== 'web';
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.title}>{t.scanTitle}</Text>
        <Text style={styles.help}>{blocked ? t.cameraBlocked : t.cameraWhy}</Text>
        <Pressable
          testID="camera-allow"
          accessibilityRole="button"
          onPress={() => void (blocked ? Linking.openSettings() : requestPermission())}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{blocked ? t.openSettings : t.allowCamera}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <CameraView
        testID="scanner"
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.frame} />
        <Text testID="scan-message" role={message ? 'alert' : undefined} style={styles.overlayText}>
          {message ?? t.scanHint}
        </Text>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 18, fontWeight: '600', color: c.text },
  help: { fontSize: 15, color: c.muted, textAlign: 'center', lineHeight: 21 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 10, backgroundColor: c.accent, marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  camera: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 20 },
  // Where to hold the code (the scanner reads the whole picture; this only guides the eye).
  frame: { width: 240, height: 240, borderRadius: 16, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  overlayText: {
    fontSize: 15,
    color: '#fff',
    textAlign: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    maxWidth: '85%',
    overflow: 'hidden',
  },
}));

import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';
import { loadApprovals } from '../approvals/store';
import { loadSettings } from '../settings/store';
import { retryReports } from '../reports/send';
import { loadHosts } from '../hosts/store';
import { loadRunbooks } from '../runbooks/store';
import { capturePairingFragment } from '../pairing/pending';
import { loadRuntimeConfig } from '../settings/runtimeConfig';
import { loadPins } from '../runbooks/pins';
import { loadViewModes } from '../runbooks/viewMode';
import { useNotificationTaps } from '../notifications/open';
import { t } from '../i18n';
import { usePalette } from '../theme';
import { CODICON_FONT, codiconFont } from '../ui/Codicon';
import { HomeTitle, HostsButton } from '../ui/HomeHeader';
import { useAppShortcuts } from '../ui/useAppShortcuts';
import { Points } from '../ui/Points';

/**
 * The web app inside another page's frame (clickjacking: taps on a hidden Run or Trust): it
 * doesn't run there. GitHub Pages can't send frame-ancestors, so the app checks itself.
 */
const framed = ((): boolean => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    return window.top !== window.self;
  } catch {
    return true; // another origin's top window: framed
  }
})();

// A pairing link (/pair#…): its token is read from the fragment and taken out of the address bar
// as soon as the app loads, before anything else can see or keep it (pairing/pending.ts).
if (Platform.OS === 'web' && !framed) capturePairingFragment();

/** A runbook or host opened by a link has the list under it, so the back arrow is always there. */
export const unstable_settings = { initialRouteName: 'index' };

/**
 * On the web a focused field gets the browser's thick black ring; show focus as the field's own
 * border in the accent colour instead (still visible from the keyboard).
 */
function useWebFocusStyle(accent: string): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = `input:focus, textarea:focus { outline: none; border-color: ${accent} !important; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [accent]);
}

function AppShortcutsSync() {
  useAppShortcuts();
  return null;
}

/** A tap on a run's notification opens its runbook at the step. */
function NotificationTaps() {
  useNotificationTaps();
  return null;
}

/** In a frame: a short note instead of the app (nothing is loaded or run). */
function FramedNotice() {
  const c = usePalette();
  return (
    <View testID="framed" style={{ flex: 1, padding: 24, gap: 8, backgroundColor: c.background }}>
      <Text role="heading" style={{ fontSize: 18, fontWeight: '600', color: c.text }}>
        {t.framedTitle}
      </Text>
      <Points items={t.framedPoints} textStyle={{ fontSize: 14, color: c.muted }} />
    </View>
  );
}

export default function RootLayout() {
  return framed ? <FramedNotice /> : <AppLayout />;
}

function AppLayout() {
  const c = usePalette();
  useWebFocusStyle(c.accent);
  // Screens render before the font is in: the glyphs appear when it is (no blank start screen).
  useFonts({ [CODICON_FONT]: codiconFont });
  useEffect(() => {
    void loadHosts();
    void loadApprovals();
    void loadSettings();
    // The web container's /config.json: its public address and library folder.
    void loadRuntimeConfig();
    void loadRunbooks();
    void loadPins();
    void loadViewModes();
    // Run reports that couldn't be sent before (no network, the server down).
    void retryReports();
  }, []);
  return (
    <>
      <StatusBar style="auto" />
      <AppShortcutsSync />
      <NotificationTaps />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          // No line under the header (on the web it was a bright one in dark mode).
          headerShadowVisible: false,
          headerTintColor: c.text,
          headerTitleStyle: { color: c.text },
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: t.appTitle, headerTitle: () => <HomeTitle />, headerRight: () => <HostsButton /> }} />
        <Stack.Screen name="runbook/[id]" options={{ title: '' }} />
        <Stack.Screen name="edit/[id]" options={{ title: t.editorTitle }} />
        <Stack.Screen name="hosts/index" options={{ title: t.hostsTitle }} />
        <Stack.Screen name="open" options={{ title: t.openLinkTitle }} />
        <Stack.Screen name="library" options={{ title: t.libraryAddTitle }} />
        <Stack.Screen name="scan" options={{ title: t.scanTitle }} />
        <Stack.Screen name="hosts/import" options={{ title: t.hostsImportTitle }} />
        <Stack.Screen name="pair" options={{ title: t.pairTitle }} />
        <Stack.Screen name="hosts/[id]" options={{ title: t.editHostTitle }} />
      </Stack>
    </>
  );
}

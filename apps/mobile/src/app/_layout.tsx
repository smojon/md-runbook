import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { loadApprovals } from '../approvals/store';
import { loadSettings } from '../settings/store';
import { loadHosts } from '../hosts/store';
import { loadRunbooks } from '../runbooks/store';
import { t } from '../i18n';
import { usePalette } from '../theme';
import { CODICON_FONT, codiconFont } from '../ui/Codicon';

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

export default function RootLayout() {
  const c = usePalette();
  useWebFocusStyle(c.accent);
  // Screens render before the font is in: the glyphs appear when it is (no blank start screen).
  useFonts({ [CODICON_FONT]: codiconFont });
  useEffect(() => {
    void loadHosts();
    void loadApprovals();
    void loadSettings();
    void loadRunbooks();
  }, []);
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.text,
          headerTitleStyle: { color: c.text },
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: t.appTitle }} />
        <Stack.Screen name="runbook/[id]" options={{ title: '' }} />
        <Stack.Screen name="hosts/index" options={{ title: t.hostsTitle }} />
        <Stack.Screen name="open" options={{ title: t.openLinkTitle }} />
        <Stack.Screen name="hosts/[id]" options={{ title: t.editHostTitle }} />
      </Stack>
    </>
  );
}

import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { loadApprovals } from '../approvals/store';
import { loadSettings } from '../settings/store';
import { loadHosts } from '../hosts/store';
import { loadRunbooks } from '../runbooks/store';
import { t } from '../i18n';
import { usePalette } from '../theme';
import { CODICON_FONT, codiconFont } from '../ui/Codicon';

export default function RootLayout() {
  const c = usePalette();
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
        <Stack.Screen name="hosts/[id]" options={{ title: t.editHostTitle }} />
      </Stack>
    </>
  );
}

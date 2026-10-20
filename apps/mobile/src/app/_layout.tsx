import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { loadHosts } from '../hosts/store';
import { t } from '../i18n';

export default function RootLayout() {
  useEffect(() => {
    void loadHosts();
  }, []);
  return (
    <>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: t.appTitle }} />
        <Stack.Screen name="runbook/[id]" options={{ title: '' }} />
        <Stack.Screen name="hosts/index" options={{ title: t.hostsTitle }} />
        <Stack.Screen name="hosts/[id]" options={{ title: t.editHostTitle }} />
      </Stack>
    </>
  );
}

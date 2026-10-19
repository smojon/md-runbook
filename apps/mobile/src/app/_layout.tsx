import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { t } from '../i18n';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: t.appTitle }} />
        <Stack.Screen name="runbook/[id]" options={{ title: '' }} />
      </Stack>
    </>
  );
}

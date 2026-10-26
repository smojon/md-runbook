import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { HostInput, addHost, getHost, pinHostKey, removeHost, updateHost, validateHost } from '../hosts/store';
import { t } from '../i18n';
import { disconnect } from '../ssh/connections';
import { themedStyles, usePalette } from '../theme';

/** Add (`id` undefined) or edit a host. */
export function HostForm({ id }: { id: string | undefined }) {
  const styles = useStyles();
  const existing = getHost(id);
  const [name, setName] = useState(existing?.name ?? '');
  const [hostname, setHostname] = useState(existing?.hostname ?? '');
  const [port, setPort] = useState(existing ? String(existing.port) : '22');
  const [username, setUsername] = useState(existing?.username ?? '');
  const [group, setGroup] = useState(existing?.group ?? '');
  const [trusted, setTrusted] = useState(existing?.hostKey !== undefined);
  const [errors, setErrors] = useState<string[]>([]);

  const input = (): HostInput => ({ name, hostname, port: /^\d+$/.test(port.trim()) ? Number(port.trim()) : NaN, username, group });
  const save = (): void => {
    const problems = validateHost(input(), t.hostErrors);
    setErrors(problems);
    if (problems.length > 0) return;
    if (existing) {
      updateHost(existing.id, input());
      void disconnect(existing.id);
    } else addHost(input());
    router.back();
  };
  const remove = (): void => {
    if (!existing) return;
    void disconnect(existing.id);
    removeHost(existing.id);
    router.back();
  };
  const forgetKey = (): void => {
    if (!existing) return;
    pinHostKey(existing.id, undefined);
    void disconnect(existing.id);
    setTrusted(false);
  };

  return (
    <>
      <Stack.Screen options={{ title: existing ? existing.name : t.newHostTitle }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <Field testID="host-name" label={t.hostName} value={name} onChange={setName} placeholder={t.hostNamePlaceholder} />
        <Field
          testID="host-hostname"
          label={t.hostHostname}
          value={hostname}
          onChange={setHostname}
          placeholder={t.hostHostnamePlaceholder}
        />
        <Field testID="host-port" label={t.hostPort} value={port} onChange={setPort} keyboard="number-pad" />
        <Field
          testID="host-username"
          label={t.hostUsername}
          value={username}
          onChange={setUsername}
          placeholder={t.hostUsernamePlaceholder}
        />
        <Field testID="host-group" label={t.hostGroup} value={group} onChange={setGroup} placeholder={t.hostGroupPlaceholder} />
        {errors.length > 0 ? (
          <View testID="host-errors" role="alert">
            {errors.map((e) => (
              <Text key={e} style={styles.error}>
                {e}
              </Text>
            ))}
          </View>
        ) : null}
        <Pressable testID="host-save" accessibilityRole="button" onPress={save} style={styles.button}>
          <Text style={styles.buttonText}>{t.save}</Text>
        </Pressable>
        {existing ? (
          <View style={styles.danger}>
            <Text style={styles.meta}>{trusted ? t.hostKeyTrusted : t.hostKeyNotTrusted}</Text>
            {trusted ? (
              <Pressable testID="host-forget-key" accessibilityRole="button" onPress={forgetKey} style={styles.link}>
                <Text style={styles.linkText}>{t.forgetHostKey}</Text>
              </Pressable>
            ) : null}
            <Pressable testID="host-delete" accessibilityRole="button" onPress={remove} style={styles.link}>
              <Text style={styles.deleteText}>{t.deleteHost}</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

function Field(p: {
  testID: string;
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  keyboard?: 'number-pad';
}) {
  const styles = useStyles();
  const colors = usePalette();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{p.label}</Text>
      <TextInput
        testID={p.testID}
        accessibilityLabel={p.label}
        style={styles.input}
        value={p.value}
        onChangeText={p.onChange}
        placeholder={p.placeholder}
        placeholderTextColor={colors.placeholder}
        keyboardType={p.keyboard ?? 'default'}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48 },
  field: { marginBottom: 14 },
  label: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    fontSize: 16,
    color: colors.text,
  },
  error: { fontSize: 13, color: colors.error, marginBottom: 6 },
  button: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: colors.accent,
    marginTop: 4,
  },
  buttonText: { fontSize: 15, color: colors.onAccent },
  danger: { marginTop: 36, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingTop: 16 },
  meta: { fontSize: 13, color: colors.muted },
  link: { paddingVertical: 10 },
  linkText: { fontSize: 15, color: colors.accent },
  deleteText: { fontSize: 15, color: colors.error },
}));

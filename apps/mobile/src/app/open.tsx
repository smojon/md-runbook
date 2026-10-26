import { APP_LINK_BASE } from '@md-runbook/core/runbookLink';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { themedStyles } from '../theme';
import { t } from '../i18n';
import { openRunbookLink } from '../runbooks/openLink';

/**
 * mdrunbook://open?… and the web app's /open?… (VS Code's Open in the App, a QR code, a pager
 * alert, a mail): the runbook link (core/runbookLink.ts) is put back together from the route's
 * query and opened.
 */
export default function OpenRoute() {
  const query = useLocalSearchParams<Record<string, string | string[]>>();
  const link = useMemo(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) q.set(k, Array.isArray(v) ? (v[0] ?? '') : v);
    return q.has('url') || q.has('rb') ? `${APP_LINK_BASE}?${q.toString()}` : undefined;
  }, [query]);
  const styles = useStyles();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!link) return;
    let live = true;
    void openRunbookLink(link).then((r) => {
      if (!live) return;
      if (r.kind === 'error') setError(r.message);
      else router.replace({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
    });
    return () => {
      live = false;
    };
  }, [link]);
  const shown = link ? error : t.linkInvalid;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Text testID="open-link-state" role={shown ? 'alert' : undefined} style={shown ? styles.error : styles.text}>
        {shown ?? t.linkOpening}
      </Text>
      {shown ? (
        <Link href="/" replace style={styles.link}>
          {t.backToRunbooks}
        </Link>
      ) : null}
    </ScrollView>
  );
}

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  content: { padding: 16 },
  text: { fontSize: 15, color: c.text },
  error: { fontSize: 15, color: c.error },
  link: { fontSize: 15, color: c.link, marginTop: 16 },
}));

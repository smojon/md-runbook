import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { themedStyles } from '../theme';
import { t } from '../i18n';
import { openRunbookLink } from '../runbooks/openLink';

/** mdrunbook://open?url=… (VS Code's Open in the App, a link in a mail): open that runbook. */
export default function OpenRoute() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  const styles = useStyles();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    void openRunbookLink(url).then((r) => {
      if (!live) return;
      if (r.kind === 'error') setError(r.message);
      else router.replace({ pathname: '/runbook/[id]', params: { id: r.runbook.id } });
    });
    return () => {
      live = false;
    };
  }, [url]);
  const shown = url ? error : t.linkInvalid;
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

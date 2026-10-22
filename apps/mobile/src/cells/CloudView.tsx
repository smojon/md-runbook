/**
 * The cloud console view of a cell's output (core/cloudViews.ts): its AWS or Google Cloud
 * resources, each with a link to the console. A list rather than a table, for phone widths;
 * display only, like the table VS Code shows.
 */
import { CloudView as View_ } from '@md-runbook/core/cloudViews';
import { Linking, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function CloudView({ view, testID }: { view: View_; testID?: string }) {
  const styles = useStyles();
  return (
    <View testID={testID} style={styles.box}>
      <Text style={styles.title}>{t.cloudTitle(view.title, view.rows.length)}</Text>
      {view.rows.map((r, i) => (
        <View key={i} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{r.cells[0] || r.cells[1]}</Text>
            <Text style={styles.meta}>
              {view.columns
                .map((c, k) => (k > 0 && r.cells[k] ? `${c} ${r.cells[k]}` : ''))
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <Pressable testID={`${testID ?? 'cloud'}-open-${i}`} accessibilityRole="link" onPress={() => void Linking.openURL(r.url)}>
            <Text style={styles.link}>{t.cloudOpen}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  box: { marginTop: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6 },
  title: { fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  text: { flex: 1 },
  name: { fontSize: 14, color: c.text },
  meta: { fontSize: 12, color: c.muted, marginTop: 1 },
  link: { fontSize: 14, color: c.link },
}));

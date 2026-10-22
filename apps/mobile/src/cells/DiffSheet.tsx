/** Compare With Previous Run: a cell's previous output against its latest, line by line. */
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { t } from '../i18n';
import { mono, themedStyles } from '../theme';
import { DiffLine } from './lineDiff';

export function DiffSheet(p: { diff: { title: string; lines: readonly DiffLine[] } | undefined; onClose(): void }) {
  const styles = useStyles();
  const changed = p.diff?.lines.some((l) => l.kind !== 'same') ?? false;
  return (
    <Modal visible={p.diff !== undefined} animationType="slide" transparent onRequestClose={p.onClose}>
      <Pressable style={styles.backdrop} onPress={p.onClose} accessibilityLabel={t.close} />
      <View testID="diff-sheet" style={styles.sheet}>
        <Text style={styles.title}>{p.diff?.title}</Text>
        {!changed ? <Text style={styles.body}>{t.diffSame}</Text> : null}
        <ScrollView>
          {p.diff?.lines.map((l, i) => (
            <Text
              key={i}
              testID={`diff-${l.kind}`}
              style={[styles.line, l.kind === 'removed' ? styles.removed : l.kind === 'added' ? styles.added : null]}
            >
              {`${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '} ${l.text}`}
            </Text>
          ))}
        </ScrollView>
        <Pressable testID="diff-close" accessibilityRole="button" onPress={p.onClose} style={styles.close}>
          <Text style={styles.link}>{t.close}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    maxHeight: '80%',
    backgroundColor: c.background,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    paddingBottom: 28,
  },
  title: { fontSize: 16, color: c.text, marginBottom: 6 },
  body: { fontSize: 13, color: c.muted, marginBottom: 6 },
  line: { fontFamily: mono, fontSize: 12, color: c.text },
  removed: { color: c.error, backgroundColor: c.codeBackground },
  added: { color: c.ok, backgroundColor: c.codeBackground },
  close: { paddingVertical: 10 },
  link: { fontSize: 15, color: c.link },
}));

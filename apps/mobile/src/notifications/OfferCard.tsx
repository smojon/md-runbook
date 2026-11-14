/**
 * The first Run all offers notifications, with what they are for, before the system asks:
 * Notify me asks for the permission (a tap, which browsers require too), Not now never offers
 * them again (Hosts & settings → Notifications turns them on).
 */
import { Platform, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles } from '../theme';

export function NotifyOfferCard(p: { onYes(): void; onNo(): void }) {
  const styles = useStyles();
  return (
    <View testID="notify-offer" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {t.notifyOfferTitle}
      </Text>
      <Text style={styles.body}>{Platform.OS === 'web' ? t.notifyOfferBodyWeb : t.notifyOfferBody}</Text>
      <View style={styles.actions}>
        <Pressable testID="notify-offer-yes" accessibilityRole="button" onPress={p.onYes} style={styles.button}>
          <Text style={styles.buttonText}>{t.notifyOfferYes}</Text>
        </Pressable>
        <Pressable testID="notify-offer-no" accessibilityRole="button" onPress={p.onNo} style={styles.secondary}>
          <Text style={styles.link}>{t.notifyOfferNo}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, marginVertical: 8, gap: 6 },
  title: { fontSize: 16, color: c.text, fontWeight: '600' },
  body: { fontSize: 13, color: c.muted, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4 },
  button: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 6, backgroundColor: c.accent },
  buttonText: { fontSize: 15, color: c.onAccent },
  secondary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 15, color: c.link },
}));

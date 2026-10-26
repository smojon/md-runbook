/**
 * The start screen's header: the app's icon with its name, and Hosts & settings as the gear at
 * the right, where phones keep settings.
 */
import { Link } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from './Codicon';

const icon = require('../../assets/icon.png') as number;

export function HomeTitle() {
  const styles = useStyles();
  return (
    <View style={styles.title}>
      <Image source={icon} style={styles.icon} accessibilityIgnoresInvertColors />
      <Text style={styles.name}>{t.appTitle}</Text>
    </View>
  );
}

export function HostsButton() {
  const styles = useStyles();
  const colors = usePalette();
  return (
    <Link href={{ pathname: '/hosts', params: {} }} asChild>
      <Pressable
        testID="hosts"
        accessibilityRole="link"
        aria-label={t.hosts}
        accessibilityLabel={t.hosts}
        hitSlop={8}
        style={styles.button}
      >
        <Codicon name="settings-gear" size={20} color={colors.text} />
      </Pressable>
    </Link>
  );
}

const useStyles = themedStyles((colors) => ({
  title: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 28, height: 28, borderRadius: 7 },
  name: { fontSize: 18, fontWeight: '600', color: colors.text },
  button: { padding: 8 },
}));

/**
 * Web on plain http (not localhost), or without IndexedDB: the app makes no SSH key there
 * (ssh/appKey.ts InsecurePageError). Shown where the key would be: Hosts & settings and the
 * pairing card.
 */
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { t } from '../i18n';
import type { WebKeyBlocker } from '../ssh/webKey';
import { Points } from './Points';

export function InsecurePageNotice({
  reason,
  textStyle,
  pointStyle,
  testID,
}: {
  reason: WebKeyBlocker;
  /** The heading's style (bold is added). */
  textStyle?: StyleProp<TextStyle>;
  /** Each point's style; the heading's when not given. */
  pointStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} role="alert">
      <Text style={[textStyle, { fontWeight: '600' }]} role="heading">
        {reason === 'insecure' ? t.insecurePageTitle : t.noKeyStorageTitle}
      </Text>
      <Points items={reason === 'insecure' ? t.insecurePagePoints : t.noKeyStoragePoints} textStyle={pointStyle ?? textStyle} />
    </View>
  );
}

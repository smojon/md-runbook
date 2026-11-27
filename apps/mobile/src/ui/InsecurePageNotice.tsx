/**
 * Web on plain http (not localhost): the app makes no SSH key there (ssh/appKey.ts
 * InsecurePageError). Shown where the key would be: Hosts & settings and the pairing card.
 */
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { t } from '../i18n';
import { Points } from './Points';

export function InsecurePageNotice({
  textStyle,
  pointStyle,
  testID,
}: {
  /** The heading's style (bold is added). */
  textStyle?: StyleProp<TextStyle>;
  /** Each point's style; the heading's when not given. */
  pointStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} role="alert">
      <Text style={[textStyle, { fontWeight: '600' }]} role="heading">
        {t.insecurePageTitle}
      </Text>
      <Points items={t.insecurePagePoints} textStyle={pointStyle ?? textStyle} />
    </View>
  );
}

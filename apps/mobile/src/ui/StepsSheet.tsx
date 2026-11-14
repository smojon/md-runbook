/**
 * Steps: every step of the runbook by name, in a bottom sheet (the app's sheet, as ⋯ More), under
 * the run bar's words for where the run is. A row goes to its cell and closes the sheet. Opened
 * from the run bar's headline, a tap on the rail, or ⋯ More → Show Steps.
 */
import { Modal, Pressable, Text, View } from 'react-native';
import { t } from '../i18n';
import type { StepsRow } from '../runbooks/steps';
import { themedStyles } from '../theme';
import { Grabber } from './Grabber';
import { StepsList } from './StepsList';
import { TimeBar } from './TimeBar';

/** Where the run is, as the run bar says it: its headline, the share done and the time left. */
export interface StepsHeader {
  headline: string;
  /** The run waits for an answer: the headline in amber. */
  waiting: boolean;
  /** `41% · 4 min left · ends ≈ 14:32`, with estimates. */
  line?: string;
  fraction?: number;
  /** Before a run: what the steps still to do will need (`Before you run: 1 confirmation · 1 secret to set`). */
  preflight?: string;
}

export function StepsHead({ header }: { header: StepsHeader }) {
  const styles = useStyles();
  return (
    <View style={styles.head}>
      <Text testID="steps-headline" style={[styles.headline, header.waiting && styles.waiting]} numberOfLines={2}>
        {header.headline}
      </Text>
      {header.fraction !== undefined ? (
        <View style={styles.bar}>
          <TimeBar fraction={header.fraction} />
        </View>
      ) : null}
      {header.line ? (
        <Text testID="steps-progress" style={styles.sub}>
          {header.line}
        </Text>
      ) : null}
      {header.preflight ? (
        <Text testID="steps-preflight" style={styles.preflight}>
          {header.preflight}
        </Text>
      ) : null}
    </View>
  );
}

export function StepsSheet({
  visible,
  rows,
  cells,
  header,
  onGo,
  onClose,
}: {
  visible: boolean;
  rows: readonly StepsRow[];
  /** The cells on screen. */
  cells?: { first: number; last: number };
  header: StepsHeader;
  /** A row was tapped: the sheet closes and the runbook goes to the cell. */
  onGo(index: number): void;
  onClose(): void;
}) {
  const styles = useStyles();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t.close} />
      <View testID="steps-sheet" style={styles.sheet}>
        <Grabber onClose={onClose} />
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.title}>
            {t.stepsTitle}
          </Text>
          <Pressable testID="steps-close" accessibilityRole="button" onPress={onClose} hitSlop={8} style={styles.close}>
            <Text style={styles.closeText}>{t.close}</Text>
          </Pressable>
        </View>
        <StepsHead header={header} />
        <StepsList rows={rows} {...(cells ? { visible: cells } : {})} onGo={onGo} />
      </View>
    </Modal>
  );
}

const useStyles = themedStyles((c) => ({
  backdrop: { flex: 1, backgroundColor: c.scrim },
  sheet: {
    maxHeight: '80%',
    backgroundColor: c.sheet,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 14,
    paddingBottom: 28,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, fontWeight: '600', color: c.text },
  close: { paddingVertical: 6, paddingHorizontal: 4 },
  closeText: { fontSize: 16, color: c.link },
  head: { paddingVertical: 8, paddingHorizontal: 2, borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: 4 },
  headline: { fontSize: 15, fontWeight: '600', color: c.text },
  waiting: { color: c.warningText },
  bar: { flexDirection: 'row', marginTop: 8 },
  sub: { fontSize: 13, color: c.muted, marginTop: 4 },
  preflight: { fontSize: 13, color: c.warningText, marginTop: 4 },
}));

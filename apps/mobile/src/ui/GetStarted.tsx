/**
 * Get Started: a short tour on the start screen, as VS Code's walkthrough (mdRunbook.getStarted).
 * A card at a time, each a title and a few points, some with the button that does it (Open the
 * sample, Hosts & settings): the sample, a first run, a host and the app's key, the team library,
 * where help is. On the screen, not over it: skippable at any card, and shown once by itself on
 * the first start (the start screen's ⋯ → Get Started shows it again).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { themedStyles, usePalette } from '../theme';
import { Codicon } from './Codicon';
import { Points } from './Points';

export type TourAction = 'sample' | 'hosts';

interface TourCard {
  title: string;
  points: readonly string[];
  action?: { id: TourAction; label: string };
}

export function GetStarted({ onAction, onClose }: { onAction(action: TourAction): void; onClose(): void }) {
  const styles = useStyles();
  const colors = usePalette();
  const [page, setPage] = useState(0);
  const cards: readonly TourCard[] = t.tourCards;
  const card = cards[page]!;
  const last = page === cards.length - 1;
  return (
    <View testID="tour" style={styles.card} accessibilityLabel={t.tourLabel}>
      <View style={styles.top}>
        <Text testID="tour-step" style={styles.step}>
          {t.tourStep(page + 1, cards.length)}
        </Text>
        <Pressable
          testID="tour-skip"
          accessibilityRole="button"
          accessibilityLabel={t.tourSkip}
          hitSlop={8}
          onPress={onClose}
          style={styles.skip}
        >
          <Text style={styles.link}>{t.tourSkip}</Text>
          <Codicon name="close" size={14} color={colors.link} />
        </Pressable>
      </View>
      <Text testID="tour-title" role="heading" style={styles.title}>
        {card.title}
      </Text>
      <Points items={card.points} textStyle={styles.point} />
      {card.action ? (
        <Pressable
          testID={`tour-action-${card.action.id}`}
          accessibilityRole="button"
          onPress={() => onAction(card.action!.id)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{card.action.label}</Text>
        </Pressable>
      ) : null}
      <View style={styles.foot}>
        <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {cards.map((c, i) => (
            <View key={c.title} style={[styles.dot, i === page && styles.dotOn]} />
          ))}
        </View>
        {page > 0 ? (
          <Pressable testID="tour-back" accessibilityRole="button" hitSlop={6} onPress={() => setPage(page - 1)} style={styles.back}>
            <Text style={styles.link}>{t.tourBack}</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID={last ? 'tour-done' : 'tour-next'}
          accessibilityRole="button"
          onPress={() => (last ? onClose() : setPage(page + 1))}
          style={({ pressed }) => [styles.next, pressed && styles.pressed]}
        >
          <Text style={styles.nextText}>{last ? t.tourDone : t.tourNext}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themedStyles((c) => ({
  card: {
    marginTop: 20,
    padding: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.surface,
    gap: 8,
  },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  step: { fontSize: 13, fontWeight: '600', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  skip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  title: { fontSize: 18, fontWeight: '600', color: c.text },
  point: { fontSize: 15, color: c.text, lineHeight: 21 },
  action: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: c.accentSoft,
    marginTop: 4,
  },
  actionText: { fontSize: 15, fontWeight: '600', color: c.link },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  dots: { flexDirection: 'row', gap: 6, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.border },
  dotOn: { backgroundColor: c.accent },
  back: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 6 },
  next: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 20, backgroundColor: c.accent },
  nextText: { fontSize: 15, fontWeight: '600', color: c.onAccent },
  link: { fontSize: 15, color: c.link },
  pressed: { opacity: 0.6 },
}));

/**
 * A QR code drawn with views (core/qr.ts makes the matrix): each row's dark runs as one view, so
 * a code of a few hundred modules stays light. Always dark on white, with its quiet zone, as
 * readers expect, in light and dark mode alike.
 */
import type { QrMatrix } from '@md-runbook/core/qr';
import { View } from 'react-native';

export function QrView({ matrix, size, testID }: { matrix: QrMatrix; size: number; testID?: string }) {
  const margin = 4;
  const cell = size / (matrix.size + margin * 2);
  return (
    <View testID={testID} accessibilityRole="image" style={{ width: size, height: size, backgroundColor: '#fff' }}>
      {matrix.dark.map((row, r) => {
        const runs: { start: number; length: number }[] = [];
        for (let c = 0; c < row.length; c++) {
          if (!row[c]) continue;
          const start = c;
          while (c < row.length && row[c]) c++;
          runs.push({ start, length: c - start });
        }
        return runs.map((run) => (
          <View
            key={`${r}-${run.start}`}
            style={{
              position: 'absolute',
              top: (r + margin) * cell,
              left: (run.start + margin) * cell,
              width: run.length * cell,
              // A hair taller, so rows don't show seams when the size isn't a whole number of pixels.
              height: cell + 0.5,
              backgroundColor: '#000',
            }}
          />
        ));
      })}
    </View>
  );
}

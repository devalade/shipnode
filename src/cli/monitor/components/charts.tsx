import { Text } from 'ink';
import { buildGauge, buildSparkline } from '../charts.js';

/** Filled part in its threshold colour, the remainder dim, so the eye reads the fill. */
export function Gauge({ percent, width }: { percent: number; width: number }) {
  const { bar, color } = buildGauge(percent, width);
  const filled = bar.replace(/░/g, '');
  return (
    <Text>
      <Text color={color}>{filled}</Text>
      <Text dimColor>{bar.slice(filled.length)}</Text>
    </Text>
  );
}

export function Sparkline({ values, width }: { values: number[]; width: number }) {
  if (values.length === 0 || width <= 0) return null;
  if (values.length === 1) {
    return <Text dimColor>{'▁'.repeat(width)}</Text>;
  }

  return (
    <Text>
      {buildSparkline(values, width).map((point, i) => (
        <Text key={i} color={point.color}>{point.char}</Text>
      ))}
    </Text>
  );
}

/** A gauge with its percentage, right-aligned to a fixed width so columns line up. */
export function Meter({ percent, width = 10 }: { percent: number; width?: number }) {
  const clamped = Math.max(0, Math.min(1, percent));
  return (
    <Text>
      <Gauge percent={clamped} width={width} />
      <Text> {`${Math.round(clamped * 100)}%`.padStart(4)}</Text>
    </Text>
  );
}

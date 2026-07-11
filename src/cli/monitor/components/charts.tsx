import { Text } from 'ink';
import { buildGauge, buildSparkline } from '../charts.js';

export function Gauge({ percent, width }: { percent: number; width: number }) {
  const { bar, color } = buildGauge(percent, width);
  return <Text color={color}>{bar}</Text>;
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

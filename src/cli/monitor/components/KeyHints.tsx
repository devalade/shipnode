import { Text } from 'ink';
import { Fragment } from 'react';

export type Hint = readonly [keys: string, label: string];

/** `⏎ open  ↑↓ select  f logs` - keys bright, labels dim, the k9s / lazygit footer. */
export function KeyHints({ hints }: { hints: readonly Hint[] }) {
  return (
    <Text wrap="truncate-end">
      {hints.map(([keys, label], index) => (
        <Fragment key={keys}>
          {index > 0 && <Text>{'  '}</Text>}
          <Text bold>{keys}</Text>
          <Text dimColor> {label}</Text>
        </Fragment>
      ))}
    </Text>
  );
}

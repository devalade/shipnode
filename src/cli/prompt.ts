import { confirm as clackConfirm, isCancel } from '@clack/prompts';
import { ui } from './ui.js';

export async function confirm(question: string): Promise<boolean> {
  const result = await clackConfirm({ message: question });
  if (isCancel(result)) {
    ui.warn('Cancelled.');
    process.exit(0);
  }
  return result as boolean;
}
